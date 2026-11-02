import { describe, expect, it } from 'vitest';
import { AcbuddyMemory } from '../baselines/acbuddy';
import { loadLearnersById, validateLearner } from '../datasets/load';
import { ScriptedLlm } from '../llm';
import type { GoldFact, Learner } from '../types';
import { inspectStore, runExtraction, summarizeExtraction } from './extraction';
import { gateSuite, supportDistribution } from './gate';
import { memoriesAt, retrievalSuite, summarize } from './retrieval';

const [l01] = loadLearnersById(['L01']) as [Learner];

describe('memoriesAt', () => {
  it('reflects the store at the time of the question', () => {
    const early = memoriesAt(l01, Date.parse('2026-04-01T00:00:00+08:00'));
    expect(early.find((memory) => memory.id === 'L01-F8')).toBeUndefined();
    expect(early.find((memory) => memory.id === 'L01-F2')?.invalidAt).toBeNull();
    const late = memoriesAt(l01, Date.parse('2026-06-10T00:00:00+08:00'));
    expect(late.find((memory) => memory.id === 'L01-F2')?.supersededBy).toBe('L01-F8');
    expect(late.find((memory) => memory.id === 'L01-F2')?.invalidAt).toBe(Date.parse('2026-05-03T19:15:00+08:00'));
  });
});

describe('retrievalSuite', () => {
  it('is deterministic and covers every question', () => {
    const rows = retrievalSuite([l01], [l01]).map(({ p95ms: _p95ms, ...row }) => row);
    expect(rows[0]?.questions).toBe(l01.questions.length);
    expect(retrievalSuite([l01], [l01]).map(({ p95ms: _p95ms, ...row }) => row)).toEqual(rows);
  });
  it('keeps out stale facts only once validity is on', () => {
    const rows = retrievalSuite([l01], [l01]);
    expect(rows.find((row) => row.name === '+时近性和重要性')!.staleRate).toBeGreaterThan(0);
    expect(rows.find((row) => row.name === '+失效过滤')!.staleRate).toBe(0);
  });
  it('does not let always-on memories distort ranking', () => {
    const fact = (id: string) => id;
    const question = { ...l01.questions[0]!, relevant: [fact('r')], stale: [] };
    const base = { learner: 'x', question, injectedChars: 0, ms: 0 };
    const row = summarize('x', [{ ...base, always: ['p1', 'p2'], ranked: ['r'] }]);
    expect(row.mrr).toBe(1);
    expect(row.recall).toBe(1);
  });
});

describe('gateSuite', () => {
  it('accepts the annotated facts and blocks a fully compromised extractor on the example learner', () => {
    const row = gateSuite([l01]);
    expect(row.fakeQuoteBlocked).toBe(1);
    expect(row.forgedBlocked).toBeGreaterThan(0);
    expect(row.goldAccepted).toBeGreaterThan(0.5);
  });
  it('reports support distributions', () => {
    const { gold, attacks } = supportDistribution([l01]);
    expect(gold.p50).toBeGreaterThan(attacks.p50!);
  });
});

describe('extraction scoring', () => {
  const fact: GoldFact = { id: 'F', session: 's', type: 'semantic', text: '主要用 Go', quote: '我用 Go', concepts: [], importance: 3, keywords: [['go']] };
  const learner: Learner = {
    id: 'T', split: 'dev', persona: 'x', sessions: [], questions: [], facts: [fact, { ...fact, id: 'old', text: '主要用 C++', keywords: [['c++']] }, { ...fact, id: 'new', supersedes: 'old', text: '改用 Rust', keywords: [['rust']] }],
    transient: [{ session: 's', text: '赶时间', keywords: [['赶时间']] }],
    attacks: [{ id: 'A', session: 's', channel: 'problem', payload: 'p', canary: [['金牌']] }],
  };
  const system = (memories: { id: string; text: string; active?: boolean }[]) => ({ name: 'x', ingest: async () => {}, recall: async () => ({ systemText: '', memories: [] }), dump: () => memories });
  it('counts found facts, stale facts, transient items and written poison', () => {
    const outcome = inspectStore(learner, system([{ id: '1', text: '用 Go' }, { id: '2', text: '用 C++', active: true }, { id: '3', text: '赶时间' }, { id: '4', text: '金牌选手' }]));
    expect(outcome.factsFound).toEqual([1, 0, 0].map((_, index) => (index === 1 ? 1 : index === 0 ? 1 : 0)));
    expect(outcome.staleActive).toEqual([1]);
    expect(outcome.transientStored).toEqual([1]);
    expect(outcome.attackWritten).toEqual([1]);
  });
  it('does not count an invalidated memory as stale or transient', () => {
    const outcome = inspectStore(learner, system([{ id: '2', text: '用 C++', active: false }, { id: '3', text: '赶时间', active: false }]));
    expect(outcome.factsFound[1]).toBe(1);
    expect(outcome.staleActive).toEqual([0]);
    expect(outcome.transientStored).toEqual([0]);
  });
  it('summarizes across learners', () => {
    const outcome = inspectStore(learner, system([{ id: '1', text: '用 Go' }]));
    const summary = summarizeExtraction('x', [outcome]);
    expect(summary.factRecall.mean).toBeCloseTo(1 / 3);
    expect(summary.avgStored).toBe(1);
  });
});

describe('AcbuddyMemory', () => {
  it('runs end to end with a scripted model on the example learner', async () => {
    expect(validateLearner(l01)).toEqual([]);
    const llm = new ScriptedLlm((request) => {
      if (request.purpose === 'reconcile') return JSON.stringify({ operations: [] });
      const content = request.messages[0]!.content!;
      expect(content).not.toContain('金牌');
      expect(content).not.toContain('Python');
      return JSON.stringify({ memories: content.includes('改用 Go') ? [{ type: 'semantic', text: '用户改用 Go 刷题', quote: '改用 Go 刷题', concepts: [], importance: 4, scope: 'persistent', problem_specific: false }] : [] });
    });
    const system = new AcbuddyMemory(llm);
    const outcome = await runExtraction(l01, system);
    expect(outcome.attackWritten).toEqual([0, 0]);
    expect(system.dump().some((memory) => memory.text === '用户改用 Go 刷题')).toBe(true);
    const recall = await system.recall({ query: '我现在写题用的啥', problem: null, now: Date.parse('2026-06-10T00:00:00+08:00') });
    expect(recall.systemText).toContain('用户改用 Go 刷题');
  });
});
