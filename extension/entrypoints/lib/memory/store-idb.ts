import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RemoteMemory } from '../api';
import type { MemoryChange, MemoryStore } from './store';
import { CLEARED_ID, fromRemote, syncFingerprint, type SyncState, type SyncStore } from './sync';
import type { MemoryRecord } from './types';

interface MemoryDb extends DBSchema {
  memories: { key: string; value: MemoryRecord };
  /** 每个对话已经提取到第几条消息 */
  progress: { key: string; value: { conversationId: string; messageCount: number; updatedAt: number } };
  /** 还没上传的改动。和记忆在同一个事务里写，改了就一定在队列里 */
  outbox: { key: string; value: { id: string; op: 'put' | 'remove' } };
  sync: { key: string; value: SyncState & { key: string } };
}

const INITIAL_STATE: SyncState = { ownerId: null, cursor: 0, clearedAt: 0, pendingClear: false };

// 不放 chrome.storage.local：它只有 10 MB，对话已经在用
export class IdbMemoryStore implements MemoryStore, SyncStore {
  private opening: Promise<IDBPDatabase<MemoryDb>> | null = null;
  constructor(private readonly name = 'acbuddy-memory') {}

  private database() {
    return (this.opening ??= openDB<MemoryDb>(this.name, 2, {
      upgrade(db) {
        for (const [store, keyPath] of [['memories', 'id'], ['progress', 'conversationId'], ['outbox', 'id'], ['sync', 'key']] as const) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
        }
      },
    }));
  }

  async all() {
    return (await this.database()).getAll('memories');
  }

  async apply({ put = [], remove = [] }: MemoryChange) {
    const transaction = (await this.database()).transaction(['memories', 'outbox'], 'readwrite');
    const memories = transaction.objectStore('memories');
    const outbox = transaction.objectStore('outbox');
    for (const id of remove) {
      await memories.delete(id);
      await outbox.put({ id, op: 'remove' });
    }
    for (const record of put) {
      const before = await memories.get(record.id);
      await memories.put(record);
      // 只多了一句本机的原话时不用上传
      if (!before || syncFingerprint(before) !== syncFingerprint(record)) await outbox.put({ id: record.id, op: 'put' });
    }
    await transaction.done;
  }

  /** 导入是替换：文件里没有的删掉，有的写入 */
  async replaceAll(records: MemoryRecord[]) {
    const keep = new Set(records.map((record) => record.id));
    await this.apply({ put: records, remove: (await this.all()).map((record) => record.id).filter((id) => !keep.has(id)) });
  }

  // ———— 同步 ————

  async syncState(): Promise<SyncState> {
    const { key: _key, ...state } = (await (await this.database()).get('sync', 'state')) ?? { key: 'state', ...INITIAL_STATE };
    return state;
  }
  async setSyncState(state: SyncState) {
    await (await this.database()).put('sync', { key: 'state', ...state });
  }
  async wipe() {
    const transaction = (await this.database()).transaction(['memories', 'outbox'], 'readwrite');
    await Promise.all([transaction.objectStore('memories').clear(), transaction.objectStore('outbox').clear(), transaction.done]);
  }
  async pendingChanges(limit: number) {
    return (await this.database()).getAll('outbox', undefined, limit);
  }
  async markSynced(ids: string[]) {
    const transaction = (await this.database()).transaction('outbox', 'readwrite');
    await Promise.all([...ids.map((id) => transaction.store.delete(id)), transaction.done]);
  }
  async get(id: string) {
    return (await this.database()).get('memories', id);
  }

  /** 应用服务器上的变化，不进上传队列。本机还没上传的改动优先，它马上会传上去；但删除总是优先 */
  async applyRemote(changes: RemoteMemory[]) {
    const state = await this.syncState();
    const transaction = (await this.database()).transaction(['memories', 'outbox'], 'readwrite');
    const memories = transaction.objectStore('memories');
    const outbox = transaction.objectStore('outbox');
    let clearedAt = state.clearedAt;
    for (const change of changes) {
      if (change.id === CLEARED_ID) {
        if (change.updatedAt <= clearedAt) continue;
        clearedAt = change.updatedAt;
        // 别的设备清空了记忆，清空之后才写的留下
        for (const memory of await memories.getAll()) {
          if (memory.createdAt <= change.updatedAt) {
            await memories.delete(memory.id);
            await outbox.delete(memory.id);
          }
        }
      } else if (change.deleted) {
        await memories.delete(change.id);
        await outbox.delete(change.id);
      } else if (!(await outbox.get(change.id))) {
        await memories.put(fromRemote(change, await memories.get(change.id)));
      }
    }
    await transaction.done;
    if (clearedAt !== state.clearedAt) await this.setSyncState({ ...(await this.syncState()), clearedAt });
  }

  // ———— 提取进度 ————

  async extractionProgress(conversationId: string) {
    return (await this.database()).get('progress', conversationId);
  }
  async setExtractedCount(conversationId: string, messageCount: number, now: number) {
    await (await this.database()).put('progress', { conversationId, messageCount, updatedAt: now });
  }
  async forgetProgress(conversationId?: string) {
    const db = await this.database();
    if (conversationId) await db.delete('progress', conversationId);
    else await db.clear('progress');
  }
}
