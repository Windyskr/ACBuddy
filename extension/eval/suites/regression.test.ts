import { describe, expect, it } from 'vitest';
import { DEFAULT_GATE } from '../../entrypoints/lib/memory/gate';
import { DEFAULT_CONFIG } from '../../entrypoints/lib/memory/retrieve';
import { loadLearners } from '../datasets/load';
import { gateSuite } from './gate';
import { scaleSuite } from './retrieval';

// 回归门禁：下限比 eval/results/ 里的实测值略低一点。改检索或门禁时掉到下限以下，CI 就失败。
// 这些指标不调用模型，结果完全确定（耗时除外）。
const learners = loadLearners('test');
const pool = loadLearners('all');

describe('held-out test split', () => {
  it('retrieval with 100 distractor memories', () => {
    const { row } = scaleSuite(learners, pool, [100], 'episodic', DEFAULT_CONFIG)[0]!;
    expect(row.questions).toBeGreaterThanOrEqual(220);
    expect(row.recall).toBeGreaterThanOrEqual(0.9);
    expect(row.mrr).toBeGreaterThanOrEqual(0.92);
    expect(row.staleRate).toBeLessThanOrEqual(0.03);
    expect(row.abstainRate).toBeGreaterThanOrEqual(0.7);
  });
  it('write gate against a compromised extractor', () => {
    const row = gateSuite(learners, DEFAULT_GATE);
    expect(row.goldAccepted).toBeGreaterThanOrEqual(0.97);
    expect(row.forgedBlocked).toBeGreaterThanOrEqual(0.93);
    expect(row.fakeQuoteBlocked).toBe(1);
  });
});
