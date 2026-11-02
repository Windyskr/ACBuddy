import { DEFAULT_ENGINE, MemoryEngine, type EngineOptions } from '../../entrypoints/lib/memory/engine';
import { DEFAULT_GATE } from '../../entrypoints/lib/memory/gate';
import { DEFAULT_CONFIG } from '../../entrypoints/lib/memory/retrieve';
import { InMemoryStore } from '../../entrypoints/lib/memory/store';
import type { Llm, MemoryRecord } from '../../entrypoints/lib/memory/types';
import type { DatasetSession, MemorySystem, RecallInput, RecallOutput } from '../types';

/** 完整方案和它的消融版本：每次关掉一个组件，看效果掉多少 */
export const ACBUDDY_VARIANTS: Record<string, Partial<EngineOptions>> = {
  acbuddy: {},
  'acbuddy-no-gate': { gate: { ...DEFAULT_GATE, evidence: false } },
  'acbuddy-no-minimize': { minimizeInput: false },
  'acbuddy-no-gate-no-minimize': { gate: { ...DEFAULT_GATE, evidence: false }, minimizeInput: false },
  'acbuddy-no-reconcile': { reconcile: false },
  'acbuddy-no-validity': { retrieve: { ...DEFAULT_CONFIG, validity: false } },
  'acbuddy-no-concepts': { retrieve: { ...DEFAULT_CONFIG, concepts: false } },
  'acbuddy-no-temporal': { retrieve: { ...DEFAULT_CONFIG, temporal: false } },
  'acbuddy-no-episodes': { attemptEpisodes: false },
  'acbuddy-no-threshold': { retrieve: { ...DEFAULT_CONFIG, minCoverage: 0 } },
  'acbuddy-no-core': { retrieve: { ...DEFAULT_CONFIG, coreSemantic: 0 } },
};

export class AcbuddyMemory implements MemorySystem {
  readonly engine: MemoryEngine;
  private readonly store = new InMemoryStore();
  private records: MemoryRecord[] = [];
  constructor(llm: Llm, public readonly name = 'acbuddy', options: Partial<EngineOptions> = ACBUDDY_VARIANTS[name] ?? {}) {
    let next = 0;
    // 编号固定才能复现：记忆内容相同，发给模型的提示词就相同，缓存才命中
    this.engine = new MemoryEngine(this.store, llm, { ...DEFAULT_ENGINE, newId: () => `m${++next}`, ...options });
  }
  async ingest(session: DatasetSession) {
    await this.engine.ingest({ id: session.id, now: Date.parse(session.at), problem: session.problem, turns: session.turns, attempts: session.attempts });
    this.records = await this.store.all();
  }
  async recall({ query, problem, now }: RecallInput): Promise<RecallOutput> {
    const retrieved = await this.engine.recall({ text: query, tags: problem?.tags ?? [], problemKey: problem?.key ?? null, now });
    return { systemText: this.engine.format(retrieved), memories: retrieved.map(({ memory }) => ({ id: memory.id, text: memory.text })) };
  }
  dump() {
    return this.records.map((record) => ({ id: record.id, text: record.text, active: record.invalidAt == null }));
  }
}
