import { completedMessages, type AgentMessage } from './agent';
import { readProblemPage, type PageReadResult } from './page-readers';
import { PLATFORMS, problemLabel, type PlatformId, type ProblemRef } from './platforms';
import { pageProblemMessage, problemMessage } from './problem-text';

export interface ConversationSummary {
  id: string;
  /** 题目键「平台:题号」，对话按它分组 */
  key: string;
  platform: PlatformId;
  problemTitle: string;
  problemUrl: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface Conversation extends ConversationSummary { messages: AgentMessage[] }
export interface ConversationCatalog {
  conversations: ConversationSummary[];
  selected: Record<string, string>;
}
export const CATALOG_KEY = 'acb-conversations';
const recordKey = (id: string) => `acb-conversation:${id}`;

// Web Locks also serialize updates from side panels in other browser windows.
const locked = <T>(work: () => Promise<T>) => navigator.locks.request(CATALOG_KEY, work);
export async function getConversationCatalog(): Promise<ConversationCatalog> {
  const stored = await chrome.storage.local.get(CATALOG_KEY);
  return (stored[CATALOG_KEY] as ConversationCatalog | undefined) ?? { conversations: [], selected: {} };
}

async function readConversation(id: string): Promise<Conversation | null> {
  const stored = await chrome.storage.local.get(recordKey(id));
  const record = stored[recordKey(id)] as Conversation | undefined;
  return record ? { ...record, messages: completedMessages(record.messages) } : null;
}

async function writeConversation(record: Conversation, catalog: ConversationCatalog) {
  const { messages: _messages, ...summary } = record;
  catalog.conversations = [summary, ...catalog.conversations.filter((item) => item.id !== record.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt);
  await chrome.storage.local.set({ [recordKey(record.id)]: record, [CATALOG_KEY]: catalog });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRIES = 20;

/**
 * 读完整题目：力扣由内容脚本查 GraphQL，其他平台在页面里读已经加载的数据。
 * 侧边栏按地址绑定题目，比页面加载快：内容脚本还没注入、页面数据还没到时，每 0.5 秒重试一次，最多等 10 秒
 */
async function loadProblem(tabId: number, problem: ProblemRef) {
  if (problem.platform === 'leetcode') {
    for (let attempt = 0; ; attempt++) {
      const data = await chrome.tabs.sendMessage(tabId, { type: 'GET_AGENT_PROBLEM', slug: problem.id }).catch(() => null);
      if (data) {
        if (!data.ok || data.slug !== problem.id || typeof data.description !== 'string' || !data.description.trim()) {
          throw new Error(data.error ?? '读取完整题目失败，请重试');
        }
        const title = data.title || data.translatedTitle || problem.id;
        const number = data.questionId ? String(data.questionId) : null;
        const url = PLATFORMS.leetcode.problemUrl(new URL(data.url).hostname, problem.id);
        return {
          problemTitle: problemLabel(number, title), problemUrl: url,
          content: problemMessage({ platform: 'leetcode', number, title, difficulty: data.difficultyCn ?? null, url, statement: data.description }),
        };
      }
      if (attempt >= RETRIES) throw new Error('无法连接题目页面，请刷新页面后重试');
      await wait(500);
    }
  }
  const platform = problem.platform;
  const url = PLATFORMS[platform].problemUrl(problem.site, problem.id);
  for (let attempt = 0; ; attempt++) {
    const result = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: readProblemPage, args: [platform, problem.id],
    }).then(([injection]) => injection?.result as PageReadResult | undefined, (): PageReadResult => ({ error: '页面还在加载', retry: true }));
    if (result && 'problem' in result) {
      if (result.unavailable || !result.problem.statement.trim()) throw new Error(result.unavailable ?? '当前题目没有可读取的题面');
      return {
        problemTitle: problemLabel(result.problem.number, result.problem.title), problemUrl: url,
        content: pageProblemMessage(platform, url, result.problem),
      };
    }
    if (!result?.retry || attempt >= RETRIES) throw new Error(result?.error ?? '读取题目失败，请刷新页面后重试');
    await wait(500);
  }
}

async function create(tabId: number, problem: ProblemRef, catalog: ConversationCatalog): Promise<Conversation> {
  const { problemTitle, problemUrl, content } = await loadProblem(tabId, problem);
  const usedTitles = new Set(catalog.conversations.filter((item) => item.key === problem.key).map((item) => item.title));
  let number = 1;
  while (usedTitles.has(`新对话 ${number}`)) number++;
  const record: Conversation = {
    id: crypto.randomUUID(), key: problem.key, platform: problem.platform, problemTitle, problemUrl,
    title: `新对话 ${number}`,
    createdAt: Date.now(), updatedAt: Date.now(),
    messages: [{ role: 'user', kind: 'problem', content }],
  };
  catalog.selected[problem.key] = record.id;
  await writeConversation(record, catalog);
  return record;
}

export const createConversation = (tabId: number, problem: ProblemRef) => locked(async () =>
  create(tabId, problem, await getConversationCatalog()),
);

export const openProblemConversation = (tabId: number, problem: ProblemRef) => locked(async () => {
  const catalog = await getConversationCatalog();
  const summary = catalog.conversations.filter((item) => item.key === problem.key)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  if (summary) {
    const record = await readConversation(summary.id);
    if (!record) throw new Error('对话记录不存在，请新建对话');
    catalog.selected[problem.key] = record.id;
    await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
    return record;
  }
  return create(tabId, problem, catalog);
});

export const selectConversation = (id: string) => locked(async () => {
  const catalog = await getConversationCatalog();
  if (!catalog.conversations.some((item) => item.id === id)) throw new Error('对话已删除，请选择其他对话');
  const record = await readConversation(id);
  if (!record) throw new Error('对话已删除，请选择其他对话');
  catalog.selected[record.key] = id;
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  return record;
});

export const saveConversation = (id: string, messages: AgentMessage[]) => locked(async () => {
  const catalog = await getConversationCatalog();
  if (!catalog.conversations.some((item) => item.id === id)) throw new Error('对话已删除');
  const record = await readConversation(id);
  if (!record) throw new Error('对话已删除');
  const firstQuestion = messages.find((message) => message.role === 'user' && message.kind !== 'problem')?.content;
  record.messages = completedMessages(messages);
  record.title = firstQuestion ? firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 48) : record.title;
  record.updatedAt = Date.now();
  await writeConversation(record, catalog);
});

export const deleteConversation = (id: string) => locked(async () => {
  const catalog = await getConversationCatalog();
  const summary = catalog.conversations.find((item) => item.id === id);
  catalog.conversations = catalog.conversations.filter((item) => item.id !== id);
  if (summary && catalog.selected[summary.key] === id) {
    const next = catalog.conversations.find((item) => item.key === summary.key);
    if (next) catalog.selected[summary.key] = next.id;
    else delete catalog.selected[summary.key];
  }
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  await chrome.storage.local.remove(recordKey(id));
  return catalog;
});
