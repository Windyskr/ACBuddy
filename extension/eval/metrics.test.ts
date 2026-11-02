import { describe, expect, it } from 'vitest';
import { clusterBootstrap, mcnemarExact, mean, ndcgAtK, percentile, precisionRecallF1, recallAtK, reciprocalRank, seededRandom } from './metrics';

describe('ranking metrics', () => {
  it('recallAtK', () => {
    expect(recallAtK(['a', 'b', 'c'], ['b', 'x'], 2)).toBe(0.5);
    expect(recallAtK(['a', 'b', 'c'], ['c'], 2)).toBe(0);
    expect(recallAtK(['a'], [], 2)).toBeNaN();
  });
  it('reciprocalRank', () => {
    expect(reciprocalRank(['a', 'b'], ['b'])).toBe(0.5);
    expect(reciprocalRank(['a'], ['z'])).toBe(0);
  });
  it('ndcgAtK', () => {
    expect(ndcgAtK(['a', 'b'], ['a', 'b'], 5)).toBeCloseTo(1);
    expect(ndcgAtK(['x', 'a'], ['a'], 5)).toBeCloseTo(1 / Math.log2(3));
    expect(ndcgAtK(['x'], ['a'], 5)).toBe(0);
  });
});

describe('precisionRecallF1', () => {
  it('computes the scores', () => {
    const { precision, recall, f1 } = precisionRecallF1(3, 1, 3);
    expect(precision).toBe(0.75);
    expect(recall).toBe(0.5);
    expect(f1).toBeCloseTo(0.6);
  });
  it('is NaN for precision when nothing was predicted', () => {
    expect(precisionRecallF1(0, 0, 3).precision).toBeNaN();
  });
});

describe('statistics', () => {
  it('percentile uses nearest rank', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([], 50)).toBeNaN();
  });
  it('seededRandom is reproducible', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    expect([a(), a()]).toEqual([b(), b()]);
  });
  it('clusterBootstrap brackets the mean and is reproducible', () => {
    const groups = [[1, 1, 0], [0, 0, 1], [1, 1, 1], [0, 1, 0]];
    const ci = clusterBootstrap(groups);
    expect(ci.mean).toBeCloseTo(mean(groups.flat()));
    expect(ci.low).toBeLessThanOrEqual(ci.mean);
    expect(ci.high).toBeGreaterThanOrEqual(ci.mean);
    expect(clusterBootstrap(groups)).toEqual(ci);
  });
  it('mcnemarExact matches the binomial test', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(5, 5)).toBe(1);
    expect(mcnemarExact(0, 6)).toBeCloseTo(2 * 0.5 ** 6);
    expect(mcnemarExact(1, 9)).toBeCloseTo(2 * (1 + 10) * 0.5 ** 10);
  });
});
