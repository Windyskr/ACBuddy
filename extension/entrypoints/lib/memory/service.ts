import type { AgentMessage, AgentSettings } from '../agent';
import { clearRemoteMemories, currentUser, getProgress, pullMemories, pushMemories, type Attempt } from '../api';
import type { Conversation } from '../agent-conversation';
import { PLATFORMS, type PlatformId } from '../platforms';
import { MemoryEngine } from './engine';
import type { SessionInput } from './extract';
import { modelLlm } from './model-llm';
import { IdbMemoryStore } from './store-idb';
import { syncOnce, type SyncResult, type SyncTransport } from './sync';
import type { MemoryRecord } from './types';

export const MEMORY_ENABLED_KEY = 'acb-memory-enabled';
const USAGE_KEY = 'acb-memory-usage';
export interface MemoryUsage { calls: number; inputTokens: number; outputTokens: number }
const LOCK = 'acb-memory';
const MAX_USER_CHARS = 4000;
const MAX_ASSISTANT_CHARS = 1500;
const MAX_TRANSCRIPT_CHARS = 16000;

const store = new IdbMemoryStore();
// 这里只读写和检索，用不到模型；提取时再按当前配置建
const offline = new MemoryEngine(store, { complete: () => Promise.reject(new Error('没有配置模型')) });

/** 题目信息开头（第一个空行之前）是代码拼的，只从这里读标签，题面里的文字混不进来 */
export function problemTags(message: AgentMessage | undefined) {
  if (message?.kind !== 'problem' || !message.content) return [];
  const line = message.content.split('\n\n')[0]!.split('\n').find((item) => item.startsWith('标签：'));
  return line ? line.slice(3).split('、').map((tag) => tag.trim()).filter(Boolean) : [];
}

/**
 * 对话转成提取的输入，只留下用户和助手的文字。第一条题目信息虽然 role 是 user，但内容来自网页，
 * 绝不能算用户的话，否则题面里的文字能冒充证据。
 */
export function turnsFrom(messages: AgentMessage[]): SessionInput['turns'] {
  const turns: SessionInput['turns'] = [];
  let total = 0;
  // 从后往前取，超长时丢掉最早的
  for (const message of [...messages].reverse()) {
    if (message.kind || message.role === 'tool' || !message.content) continue;
    const limit = message.role === 'user' ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    const content = message.content.length > limit ? `${message.content.slice(0, limit)}…` : message.content;
    if (total + content.length > MAX_TRANSCRIPT_CHARS) break;
    total += content.length;
    turns.unshift({ role: message.role as 'user' | 'assistant', content });
  }
  return turns;
}

async function attemptsSince(platform: PlatformId, slug: string, since: number) {
  if (!PLATFORMS[platform].tracked) return [];
  try {
    const { attempts } = await getProgress(slug);
    return attempts.filter((attempt: Attempt) => Date.parse(attempt.createdAt) > since).reverse().map((attempt: Attempt) => ({
      id: attempt.id, result: attempt.result, verdict: attempt.verdict ?? attempt.result, language: attempt.language ?? '未知语言', at: attempt.createdAt,
    }));
  } catch {
    return []; // 没登录或网络不通时只是少一条事件，不影响提取
  }
}

const locked = <T>(work: () => Promise<T>) => navigator.locks.request(LOCK, work);

const transport: SyncTransport = { currentUser, pull: pullMemories, push: pushMemories, clear: clearRemoteMemories };
let syncError = '';
let lastSyncAt = 0;
/** 同步失败不影响记忆的使用，这里只记下原因，下次再试 */
async function syncUnlocked(): Promise<SyncResult | 'failed'> {
  try {
    const result = await syncOnce(store, transport);
    syncError = '';
    lastSyncAt = Date.now();
    return result;
  } catch (reason) {
    syncError = reason instanceof Error ? reason.message : '同步失败';
    console.warn('[memory] 同步失败', reason);
    return 'failed';
  }
}
export const syncMemories = () => locked(syncUnlocked);
/** 上次同步失败的原因，没有就是空字符串 */
export const memorySyncError = () => syncError;
/** 距离上次同步超过这么久才同步，切回面板时用 */
export const syncIfStale = (maxAgeMs: number) => (Date.now() - lastSyncAt < maxAgeMs ? Promise.resolve(null) : syncMemories());
let syncTimer: ReturnType<typeof setTimeout> | undefined;
/** 用户连着删几条时合成一次上传：每个账号每天的同步次数有限 */
function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncMemories(), 3000);
}

export const listMemories = () => store.all();

/**
 * 检索这次提问相关的记忆。present 是这段对话里已经给过模型的（id 到文字），这些不再重复注入：
 * 它们还在之前的提问里，会原样重发。text 只含新增的部分，used 是全部相关的。
 * 给过的记忆后来被删除或修改了，stale 为 true：调用方要撤掉之前注入的记忆，这次重新给一份完整的，
 * 不然删掉的内容还会一直发给模型
 */
export async function recallMemories(input: { text: string; tags: string[]; problemKey: string | null; present?: Map<string, string> }) {
  const current = new Map((await store.all()).map((memory) => [memory.id, memory.text]));
  const stale = [...(input.present ?? [])].some(([id, text]) => current.get(id) !== text);
  const present = stale ? undefined : input.present;
  const retrieved = await offline.recall({ text: input.text, tags: input.tags, problemKey: input.problemKey, now: Date.now() });
  const fresh = retrieved.filter((item) => present?.get(item.memory.id) !== item.memory.text);
  return { text: offline.format(fresh), used: retrieved.map((item) => item.memory), stale };
}

export async function searchMemories(query: string) {
  const hits = await offline.search({ text: query, tags: [], problemKey: null, now: Date.now() });
  return hits.map(({ memory }) => ({
    text: memory.text,
    time: new Date(memory.validFrom).toISOString().slice(0, 10),
    ...(memory.invalidAt != null ? { noLongerTrueSince: new Date(memory.invalidAt).toISOString().slice(0, 10) } : {}),
  }));
}

export const removeMemory = (id: string) => locked(async () => {
  const removed = await offline.remove(id);
  syncSoon();
  return removed;
});

export const editMemory = (record: MemoryRecord, text: string) => locked(async () => {
  await store.apply({ put: [{ ...record, text }] });
  syncSoon();
});

/** 清空本机和账号里的记忆。连不上服务器时先记下来，下次同步补上 */
export const clearMemories = () => locked(async () => {
  await store.wipe();
  await store.forgetProgress();
  const state = await store.syncState();
  if (state.ownerId != null) {
    await store.setSyncState({ ...state, pendingClear: true });
    await syncUnlocked();
  }
});

export const exportMemories = () => store.all();

/** 导入是替换。文件来自用户手里，但还是逐条检查结构，坏记录不进库 */
export const importMemories = (records: unknown) => locked(async () => {
  if (!Array.isArray(records)) throw new Error('文件格式不对');
  const valid = records.filter((record): record is MemoryRecord => {
    const item = record as Partial<MemoryRecord> | null;
    return typeof item?.id === 'string' && typeof item.text === 'string' && ['semantic', 'episodic', 'procedural'].includes(item.type as string)
      && Array.isArray(item.concepts) && Array.isArray(item.evidence) && Array.isArray(item.sources) && typeof item.validFrom === 'number';
  });
  await store.replaceAll(valid);
  syncSoon();
  return valid.length;
});

/** 整理记忆累计花了多少：用的是用户自己的 API Key，要看得到 */
export async function memoryUsage(): Promise<MemoryUsage> {
  const stored = await chrome.storage.local.get(USAGE_KEY);
  return (stored[USAGE_KEY] as MemoryUsage | undefined) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
}
async function addUsage(usage: MemoryUsage) {
  const total = await memoryUsage();
  await chrome.storage.local.set({ [USAGE_KEY]: { calls: total.calls + usage.calls, inputTokens: total.inputTokens + usage.inputTokens, outputTokens: total.outputTokens + usage.outputTokens } });
}

/** 对话有没有还没提取的新内容 */
export async function hasNewTurns(conversation: Conversation) {
  const done = (await store.extractionProgress(conversation.id))?.messageCount ?? 0;
  return conversation.messages.slice(done).some((message) => message.role === 'user' && !message.kind);
}

/** 提取一段对话里新增的内容。失败时进度不动，下次再试 */
export async function extractConversation(conversation: Conversation, settings: AgentSettings, signal?: AbortSignal) {
  return locked(async () => {
    const progress = await store.extractionProgress(conversation.id);
    const fresh = conversation.messages.slice(progress?.messageCount ?? 0);
    if (!fresh.some((message) => message.role === 'user' && !message.kind)) return null;
    // 先拉一次，和旧记忆比较时才能看到别的设备刚写的
    await syncUnlocked();
    const now = Date.now();
    const separator = conversation.key.indexOf(':');
    const slug = conversation.key.slice(separator + 1);
    const model = modelLlm(settings, { signal });
    const usage: MemoryUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
    const engine = new MemoryEngine(store, {
      async complete(request) {
        const reply = await model.complete(request);
        usage.calls++;
        usage.inputTokens += reply.inputTokens;
        usage.outputTokens += reply.outputTokens;
        return reply;
      },
    });
    const report = await engine.ingest({
      id: conversation.id, now,
      problem: { key: conversation.key, title: conversation.problemTitle, tags: problemTags(conversation.messages[0]) },
      turns: turnsFrom(fresh),
      attempts: await attemptsSince(conversation.platform, slug, progress?.updatedAt ?? conversation.createdAt),
    });
    await store.setExtractedCount(conversation.id, conversation.messages.length, now);
    await addUsage(usage);
    await syncUnlocked();
    return report;
  });
}

/** 删对话不删记忆（记忆已经独立于对话），只清掉进度 */
export const forgetConversationProgress = (conversationId: string) => store.forgetProgress(conversationId);
