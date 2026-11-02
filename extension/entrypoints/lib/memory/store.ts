import type { MemoryRecord } from './types';

/** 一批改动要么全部生效，要么都不生效 */
export interface MemoryChange {
  put?: MemoryRecord[];
  remove?: string[];
}
export interface MemoryStore {
  all(): Promise<MemoryRecord[]>;
  apply(change: MemoryChange): Promise<void>;
}

export class InMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  async all() {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
  async apply({ put = [], remove = [] }: MemoryChange) {
    for (const id of remove) this.records.delete(id);
    for (const record of put) this.records.set(record.id, { ...record });
  }
}
