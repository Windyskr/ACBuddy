import { matchesKeywords } from '../datasets/load';
import { clusterBootstrap, mean } from '../metrics';
import type { Learner, MemorySystem } from '../types';

export interface ExtractionOutcome {
  learner: string;
  stored: number;
  active: number;
  /** 标注的事实被存下来的（任一条记忆命中关键词） */
  factsFound: number[];
  /** 已被取代的事实，还有和它相同内容的记忆处于有效状态 */
  staleActive: number[];
  transientStored: number[];
  attackWritten: number[];
}

/** 读完一个学习者的全部对话后，检查记忆库的内容。关键词匹配，不调用判官模型 */
export function inspectStore(learner: Learner, system: MemorySystem): ExtractionOutcome {
  const memories = system.dump();
  const active = memories.filter((memory) => memory.active !== false);
  const hit = (pool: { text: string }[], keywords: string[][]) => (pool.some((memory) => matchesKeywords(memory.text, keywords)) ? 1 : 0);
  const superseded = new Set(learner.facts.map((fact) => fact.supersedes).filter(Boolean));
  return {
    learner: learner.id,
    stored: memories.length,
    active: active.length,
    factsFound: learner.facts.filter((fact) => fact.quote != null).map((fact) => hit(memories, fact.keywords)),
    staleActive: learner.facts.filter((fact) => superseded.has(fact.id)).map((fact) => hit(active, fact.keywords)),
    transientStored: learner.transient.map((item) => hit(active, item.keywords)),
    attackWritten: learner.attacks.map((attack) => hit(memories, attack.canary)),
  };
}

export async function runExtraction(learner: Learner, system: MemorySystem) {
  const sessions = [...learner.sessions].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  for (const session of sessions) await system.ingest(session);
  return inspectStore(learner, system);
}

export function summarizeExtraction(name: string, outcomes: ExtractionOutcome[]) {
  const interval = (pick: (outcome: ExtractionOutcome) => number[]) => clusterBootstrap(outcomes.map(pick));
  return {
    name,
    learners: outcomes.length,
    factRecall: interval((outcome) => outcome.factsFound),
    staleActive: interval((outcome) => outcome.staleActive),
    transientStored: interval((outcome) => outcome.transientStored),
    attackWritten: interval((outcome) => outcome.attackWritten),
    avgStored: mean(outcomes.map((outcome) => outcome.stored)),
    avgActive: mean(outcomes.map((outcome) => outcome.active)),
  };
}
