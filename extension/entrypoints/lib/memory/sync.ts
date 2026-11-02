import { ApiError, type MemoryUpload, type RemoteMemory } from '../api';
import type { MemoryRecord } from './types';

// 记忆跟随账号同步，对话不同步。本机改动先进上传队列，所以离线也能用，联网后再传。
// 顺序是先拉后传：别的设备的删除和清空要先生效，否则本机的旧改动会把删掉的内容写回去。

/** 服务器上表示「这个账号清空过记忆」的标记 */
export const CLEARED_ID = '__cleared__';
const BATCH = 20;
// 服务器各节点的时钟可能差几秒，游标往回多取一分钟。重复拿到的记录再应用一次也没关系
const CURSOR_OVERLAP_MS = 60_000;

export interface SyncState {
  /** 本地数据属于哪个账号。null 表示还没登录过，这时的记忆是匿名的 */
  ownerId: number | null;
  cursor: number;
  /** 已经处理到哪一次清空 */
  clearedAt: number;
  /** 清空时没连上服务器，下次要补上 */
  pendingClear: boolean;
}

export interface SyncStore {
  syncState(): Promise<SyncState>;
  setSyncState(state: SyncState): Promise<void>;
  wipe(): Promise<void>;
  pendingChanges(limit: number): Promise<{ id: string; op: 'put' | 'remove' }[]>;
  markSynced(ids: string[]): Promise<void>;
  get(id: string): Promise<MemoryRecord | undefined>;
  applyRemote(changes: RemoteMemory[]): Promise<void>;
}

export interface SyncTransport {
  currentUser(): Promise<{ user: { id: number } }>;
  pull(since: number, after: string): Promise<{ memories: RemoteMemory[]; more: boolean }>;
  push(put: MemoryUpload[], remove: string[]): Promise<unknown>;
  clear(): Promise<{ clearedAt: number }>;
}

/**
 * 上传的内容。证据里的用户原话是对话内容，只留在本机；判题记录的编号要带上，
 * 别的设备靠它判断这条记录写过了。超出接口限制的部分截掉最早的，放不下的返回 null。
 */
export function toUpload(record: MemoryRecord): MemoryUpload | null {
  if (!record.text.trim() || record.text.length > 1000 || !record.id || record.id.length > 120 || record.id === CLEARED_ID) return null;
  return {
    id: record.id,
    type: record.type,
    text: record.text,
    concepts: record.concepts.filter((concept) => concept.length <= 40).slice(0, 30),
    problemKey: record.problemKey?.slice(0, 200) ?? null,
    importance: Math.min(5, Math.max(1, Math.round(record.importance) || 3)),
    attemptIds: record.evidence.flatMap((item) => (item.kind === 'attempt' ? [item.attemptId] : [])).slice(-100),
    sources: record.sources.filter((source) => source.length <= 120).slice(-100),
    validFrom: Math.round(record.validFrom),
    invalidAt: record.invalidAt == null ? null : Math.round(record.invalidAt),
    createdAt: Math.round(record.createdAt),
    supersededBy: record.supersededBy,
  };
}

/** 两个版本上传的内容一样，就不用再传一次 */
export const syncFingerprint = (record: MemoryRecord) => JSON.stringify(toUpload(record));

/** 服务器上的记忆写回本机，本机已有的原话保留 */
export function fromRemote(remote: RemoteMemory, local: MemoryRecord | undefined): MemoryRecord {
  return {
    id: remote.id, type: remote.type, text: remote.text, concepts: remote.concepts, problemKey: remote.problemKey, importance: remote.importance,
    evidence: [
      ...(local?.evidence.filter((item) => item.kind === 'user_quote') ?? []),
      ...remote.attemptIds.map((attemptId) => ({ kind: 'attempt' as const, attemptId })),
    ],
    sources: remote.sources, validFrom: remote.validFrom, invalidAt: remote.invalidAt, createdAt: remote.createdAt, supersededBy: remote.supersededBy,
  };
}

const FRESH_STATE: SyncState = { ownerId: null, cursor: 0, clearedAt: 0, pendingClear: false };

export type SyncResult = 'synced' | 'logged-out';

/** 同步一次。网络或服务器出错时抛错，本地数据和上传队列都不动，下次接着来 */
export async function syncOnce(store: SyncStore, transport: SyncTransport): Promise<SyncResult> {
  let userId: number;
  try {
    userId = (await transport.currentUser()).user.id;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error;
    // 退出登录后，这台设备上不留账号的记忆。没登录过的匿名记忆不动，登录时会归到账号下
    if ((await store.syncState()).ownerId != null) {
      await store.wipe();
      await store.setSyncState(FRESH_STATE);
    }
    return 'logged-out';
  }

  let state = await store.syncState();
  if (state.ownerId != null && state.ownerId !== userId) {
    // 换了账号：上一个账号的记忆不能留给这个账号，更不能传上去
    await store.wipe();
    state = FRESH_STATE;
  }
  if (state.ownerId !== userId) {
    state = { ...state, ownerId: userId };
    await store.setSyncState(state);
  }

  if (state.pendingClear) {
    const { clearedAt } = await transport.clear();
    // 自己刚清空的不用再处理一次，否则清空之后新写的也会被删掉
    state = { ...state, pendingClear: false, clearedAt: Math.max(state.clearedAt, clearedAt) };
    await store.setSyncState(state);
  }

  let since = Math.max(0, state.cursor - CURSOR_OVERLAP_MS);
  let after = '';
  let cursor = state.cursor;
  for (;;) {
    const page = await transport.pull(since, after);
    await store.applyRemote(page.memories);
    const last = page.memories.at(-1);
    if (last) {
      since = last.updatedAt;
      after = last.id;
      cursor = Math.max(cursor, last.updatedAt);
    }
    if (!page.more) break;
  }
  await store.setSyncState({ ...(await store.syncState()), cursor });

  for (;;) {
    const changes = await store.pendingChanges(BATCH);
    if (!changes.length) break;
    const put: MemoryUpload[] = [];
    const remove: string[] = [];
    for (const change of changes) {
      const record = change.op === 'put' ? await store.get(change.id) : undefined;
      const upload = record && toUpload(record);
      if (upload) put.push(upload);
      else if (change.op === 'remove' && change.id.length <= 120) remove.push(change.id);
      // 其他情况（记录已经没了、内容超限）传不上去，从队列里拿掉，不然会一直卡住后面的改动
    }
    if (put.length || remove.length) await transport.push(put, remove);
    await store.markSynced(changes.map((change) => change.id));
  }
  return 'synced';
}
