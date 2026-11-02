import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ApiError, type MemoryUpload, type RemoteMemory } from '../api';
import { IdbMemoryStore } from './store-idb';
import { CLEARED_ID, syncFingerprint, syncOnce, toUpload, type SyncTransport } from './sync';
import type { MemoryRecord } from './types';

/** 和 functions/api 的接口同样的语义：后写的覆盖先写的，删除优先，按 (updatedAt, id) 翻页 */
class FakeServer {
  rows = new Map<string, RemoteMemory>();
  clock = 1000;
  pushes: { put: MemoryUpload[]; remove: string[] }[] = [];
  offline = false;
  pageSize = 200;
  transport(userId: number | null): SyncTransport {
    const guard = () => {
      if (this.offline) throw new TypeError('Failed to fetch');
      if (userId == null) throw new ApiError('未登录', 401);
    };
    return {
      currentUser: async () => { guard(); return { user: { id: userId! } }; },
      pull: async (since, after) => {
        guard();
        const sorted = [...this.rows.values()].filter((row) => row.updatedAt > since || (row.updatedAt === since && row.id > after))
          .sort((x, y) => x.updatedAt - y.updatedAt || x.id.localeCompare(y.id));
        return { memories: sorted.slice(0, this.pageSize), more: sorted.length > this.pageSize };
      },
      push: async (put, remove) => {
        guard();
        this.pushes.push({ put, remove });
        const now = ++this.clock;
        for (const record of put) {
          if (!this.rows.get(record.id)?.deleted) this.rows.set(record.id, { ...record, updatedAt: now, deleted: false });
        }
        for (const id of remove) this.rows.set(id, { ...this.tombstone(id), updatedAt: now });
      },
      clear: async () => {
        guard();
        this.rows.clear();
        const now = ++this.clock;
        this.rows.set(CLEARED_ID, { ...this.tombstone(CLEARED_ID), updatedAt: now });
        return { clearedAt: now };
      },
    };
  }
  private tombstone(id: string): RemoteMemory {
    return { id, type: 'episodic', text: '', concepts: [], problemKey: null, importance: 3, attemptIds: [], sources: [], validFrom: 0, invalidAt: null, createdAt: 0, supersededBy: null, updatedAt: 0, deleted: true };
  }
}

let counter = 0;
const device = () => new IdbMemoryStore(`device-${++counter}`);
const record = (id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id, type: 'semantic', text: `记忆 ${id}`, concepts: [], problemKey: null, importance: 3,
  evidence: [{ kind: 'user_quote', sessionId: 'conversation-1', quote: '这是用户在对话里的原话' }],
  sources: [], validFrom: 500, invalidAt: null, createdAt: 500, supersededBy: null, ...extra,
});
const texts = async (store: IdbMemoryStore) => (await store.all()).map((item) => item.text).sort();

describe('syncing between devices', () => {
  it('moves memories to the other device, never the quotes', async () => {
    const server = new FakeServer();
    const a = device();
    const b = device();
    await a.apply({ put: [record('m1', { evidence: [{ kind: 'user_quote', sessionId: 'c', quote: '这是用户在对话里的原话' }, { kind: 'attempt', attemptId: 42 }] })] });
    await syncOnce(a, server.transport(1));
    expect(JSON.stringify(server.pushes)).not.toContain('原话');
    expect(JSON.stringify(server.pushes)).not.toContain('conversation');
    await syncOnce(b, server.transport(1));
    const [copied] = await b.all();
    expect(copied?.text).toBe('记忆 m1');
    expect(copied?.evidence).toEqual([{ kind: 'attempt', attemptId: 42 }]);
  });
  it('carries edits across and keeps the local quote', async () => {
    const server = new FakeServer();
    const a = device();
    const b = device();
    await a.apply({ put: [record('m1')] });
    await syncOnce(a, server.transport(1));
    await syncOnce(b, server.transport(1));
    await b.apply({ put: [{ ...(await b.get('m1'))!, text: '在第二台设备上改过' }] });
    await syncOnce(b, server.transport(1));
    await syncOnce(a, server.transport(1));
    const edited = await a.get('m1');
    expect(edited?.text).toBe('在第二台设备上改过');
    expect(edited?.evidence).toEqual([{ kind: 'user_quote', sessionId: 'conversation-1', quote: '这是用户在对话里的原话' }]);
  });
  it('carries deletions across', async () => {
    const server = new FakeServer();
    const a = device();
    const b = device();
    await a.apply({ put: [record('m1'), record('m2')] });
    await syncOnce(a, server.transport(1));
    await syncOnce(b, server.transport(1));
    await a.apply({ remove: ['m1'] });
    await syncOnce(a, server.transport(1));
    await syncOnce(b, server.transport(1));
    expect(await texts(b)).toEqual(['记忆 m2']);
  });
  it('lets a deletion beat an unsynced edit on the other device', async () => {
    const server = new FakeServer();
    const a = device();
    const b = device();
    await a.apply({ put: [record('m1')] });
    await syncOnce(a, server.transport(1));
    await syncOnce(b, server.transport(1));
    await b.apply({ put: [{ ...(await b.get('m1'))!, text: '离线时改的' }] });
    await a.apply({ remove: ['m1'] });
    await syncOnce(a, server.transport(1));
    await syncOnce(b, server.transport(1));
    expect(await b.all()).toEqual([]);
    expect(await b.pendingChanges(10)).toEqual([]);
    expect(server.rows.get('m1')?.deleted).toBe(true);
  });
  it('keeps an unsynced local edit over the older version from the server, then uploads it', async () => {
    const server = new FakeServer();
    const a = device();
    const b = device();
    await a.apply({ put: [record('m1')] });
    await syncOnce(a, server.transport(1));
    await syncOnce(b, server.transport(1));
    await a.apply({ put: [{ ...(await a.get('m1'))!, text: 'A 改的' }] });
    await syncOnce(a, server.transport(1));
    await b.apply({ put: [{ ...(await b.get('m1'))!, text: 'B 后改的' }] });
    await syncOnce(b, server.transport(1));
    expect((await b.get('m1'))?.text).toBe('B 后改的');
    expect(server.rows.get('m1')?.text).toBe('B 后改的');
  });
  it('clearing on one device empties the other, but keeps what was written after', async () => {
    const server = new FakeServer();
    const a = device();
    const b = device();
    await a.apply({ put: [record('old')] });
    await syncOnce(a, server.transport(1));
    await syncOnce(b, server.transport(1));
    await a.wipe();
    await a.setSyncState({ ...(await a.syncState()), pendingClear: true });
    await syncOnce(a, server.transport(1));
    await b.apply({ put: [record('newer', { createdAt: server.clock + 100 })] });
    await syncOnce(b, server.transport(1));
    expect(await texts(b)).toEqual(['记忆 newer']);
    await syncOnce(a, server.transport(1));
    expect(await texts(a)).toEqual(['记忆 newer']);
  });
  it('does not delete again what was written after an earlier clear', async () => {
    const server = new FakeServer();
    const a = device();
    await a.setSyncState({ ...(await a.syncState()), ownerId: 1, pendingClear: true });
    await syncOnce(a, server.transport(1));
    await a.apply({ put: [record('after', { createdAt: 1 })] });
    await syncOnce(a, server.transport(1));
    await syncOnce(a, server.transport(1));
    expect(await texts(a)).toEqual(['记忆 after']);
  });
  it('pages through more than one screen of changes', async () => {
    const server = new FakeServer();
    server.pageSize = 3;
    const a = device();
    const b = device();
    await a.apply({ put: Array.from({ length: 50 }, (_, index) => record(`m${index}`)) });
    await syncOnce(a, server.transport(1));
    expect(server.pushes.every(({ put, remove }) => put.length + remove.length <= 20)).toBe(true);
    await syncOnce(b, server.transport(1));
    expect(await b.all()).toHaveLength(50);
  });
});

describe('accounts', () => {
  it('moves anonymous memories into the account on first login', async () => {
    const server = new FakeServer();
    const a = device();
    await a.apply({ put: [record('anonymous')] });
    expect(await syncOnce(a, server.transport(null))).toBe('logged-out');
    expect(await texts(a)).toEqual(['记忆 anonymous']);
    expect(await syncOnce(a, server.transport(1))).toBe('synced');
    expect(server.rows.has('anonymous')).toBe(true);
    expect((await a.syncState()).ownerId).toBe(1);
  });
  it('removes account memories from this device on logout and restores them on login', async () => {
    const server = new FakeServer();
    const a = device();
    await a.apply({ put: [record('m1')] });
    await syncOnce(a, server.transport(1));
    await syncOnce(a, server.transport(null));
    expect(await a.all()).toEqual([]);
    expect(await a.syncState()).toMatchObject({ ownerId: null, cursor: 0 });
    await syncOnce(a, server.transport(1));
    expect(await texts(a)).toEqual(['记忆 m1']);
  });
  it('never carries one account\'s memories into another', async () => {
    const first = new FakeServer();
    const second = new FakeServer();
    const a = device();
    await a.apply({ put: [record('private')] });
    await syncOnce(a, first.transport(1));
    await a.apply({ put: [record('not-uploaded-yet')] });
    await syncOnce(a, second.transport(2));
    expect(await a.all()).toEqual([]);
    expect(second.pushes).toEqual([]);
    expect((await a.syncState()).ownerId).toBe(2);
  });
});

describe('when things go wrong', () => {
  it('keeps everything on network errors and picks up where it left off', async () => {
    const server = new FakeServer();
    const a = device();
    await a.apply({ put: [record('m1')] });
    await syncOnce(a, server.transport(1));
    await a.apply({ put: [record('m2')] });
    server.offline = true;
    await expect(syncOnce(a, server.transport(1))).rejects.toThrow('Failed to fetch');
    expect(await texts(a)).toEqual(['记忆 m1', '记忆 m2']);
    expect(await a.pendingChanges(10)).toEqual([{ id: 'm2', op: 'put' }]);
    server.offline = false;
    await syncOnce(a, server.transport(1));
    expect(server.rows.has('m2')).toBe(true);
    expect(await a.pendingChanges(10)).toEqual([]);
  });
  it('drops a record the server could never accept, instead of blocking the queue', async () => {
    const server = new FakeServer();
    const a = device();
    await a.apply({ put: [record('bad', { text: '字'.repeat(1001) }), record('good')] });
    await syncOnce(a, server.transport(1));
    expect(server.rows.has('good')).toBe(true);
    expect(server.rows.has('bad')).toBe(false);
    expect(await a.pendingChanges(10)).toEqual([]);
  });
});

describe('what counts as a change', () => {
  it('does not queue an upload when only the local quote changed', async () => {
    const a = device();
    const original = record('m1');
    await a.apply({ put: [original] });
    await a.markSynced(['m1']);
    await a.apply({ put: [{ ...original, evidence: [...original.evidence, { kind: 'user_quote', sessionId: 'c2', quote: '又说了一次' }] }] });
    expect(await a.pendingChanges(10)).toEqual([]);
    await a.apply({ put: [{ ...original, text: '真的改了' }] });
    expect(await a.pendingChanges(10)).toEqual([{ id: 'm1', op: 'put' }]);
  });
  it('does not mark records from the server for upload again', async () => {
    const server = new FakeServer();
    const a = device();
    const b = device();
    await a.apply({ put: [record('m1')] });
    await syncOnce(a, server.transport(1));
    server.pushes.length = 0;
    await syncOnce(b, server.transport(1));
    expect(server.pushes).toEqual([]);
    expect(await b.pendingChanges(10)).toEqual([]);
  });
  it('replaces on import: records missing from the file are removed', async () => {
    const a = device();
    await a.apply({ put: [record('keep'), record('drop')] });
    await a.markSynced(['keep', 'drop']);
    await a.replaceAll([record('keep'), record('new')]);
    expect(await texts(a)).toEqual(['记忆 keep', '记忆 new']);
    expect((await a.pendingChanges(10)).sort((x, y) => x.id.localeCompare(y.id))).toEqual([{ id: 'drop', op: 'remove' }, { id: 'new', op: 'put' }]);
  });
});

describe('upload format', () => {
  it('stays within the API limits', () => {
    const big = toUpload(record('m', {
      concepts: Array.from({ length: 40 }, (_, index) => `知识点${index}`),
      sources: Array.from({ length: 150 }, (_, index) => `s${index}`),
      evidence: Array.from({ length: 150 }, (_, index) => ({ kind: 'attempt' as const, attemptId: index })),
      importance: 9,
    }))!;
    expect(big.concepts).toHaveLength(30);
    expect(big.sources).toHaveLength(100);
    expect(big.attemptIds).toHaveLength(100);
    expect(big.importance).toBe(5);
    expect(toUpload(record(CLEARED_ID))).toBeNull();
    expect(toUpload(record('m', { text: ' ' }))).toBeNull();
  });
  it('has the same fingerprint regardless of quotes', () => {
    expect(syncFingerprint(record('m'))).toBe(syncFingerprint(record('m', { evidence: [] })));
  });
});
