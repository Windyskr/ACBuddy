import { describe, expect, it } from 'vitest';
import { loadLearners, matchesKeywords, validateLearner } from './load';

describe('TutorMem dataset', () => {
  it('passes every structural check', () => {
    expect(loadLearners('all').flatMap(validateLearner)).toEqual([]);
  });
  it('has unique learner ids and both splits', () => {
    const learners = loadLearners('all');
    expect(new Set(learners.map((learner) => learner.id)).size).toBe(learners.length);
  });
});

describe('matchesKeywords', () => {
  it('needs every group to match', () => {
    expect(matchesKeywords('主要用 Go 写题', [['go', 'golang'], ['写题', '刷题']])).toBe(true);
    expect(matchesKeywords('主要用 Go', [['go'], ['写题']])).toBe(false);
    expect(matchesKeywords('anything', [])).toBe(false);
  });
});
