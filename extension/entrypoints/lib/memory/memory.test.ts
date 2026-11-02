import { describe, expect, it } from 'vitest';
import { bm25Search } from './bm25';
import { conceptsIn, normalizeConcepts } from './concepts';
import { askingAboutPast, DEFAULT_CONFIG, monthWindow, retrieve } from './retrieve';
import { tokenize } from './tokenize';
import type { MemoryRecord } from './types';

const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;
function memory(id: string, text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, type: 'semantic', text, concepts: [], problemKey: null, importance: 3, evidence: [], sources: [],
    validFrom: NOW - 10 * DAY, invalidAt: null, createdAt: NOW - 10 * DAY, supersededBy: null, ...extra,
  };
}
const query = (text: string, extra = {}) => ({ text, tags: [], problemKey: null, now: NOW, ...extra });

describe('tokenize', () => {
  it('keeps language names the segmenter would split', () => {
    expect(tokenize('我主要用 C++ 和 C#')).toEqual(expect.arrayContaining(['c++', 'c#', '主要']));
  });
  it('lowercases and folds full-width text', () => {
    expect(tokenize('ＤＰ Dp')).toEqual(['dp', 'dp']);
  });
  it('matches across unstable word segmentation through bigrams', () => {
    expect(tokenize('滑动窗口')).toContain('滑动');
    expect(tokenize('滑动窗口', { bigrams: false })).not.toContain('滑动');
  });
  it('drops function words', () => {
    expect(tokenize('我的', { bigrams: false })).toEqual([]);
  });
});

describe('bm25Search', () => {
  const docs = [
    { id: 'a', tokens: ['二分', '查找', '边界'] },
    { id: 'b', tokens: ['动态', '规划'] },
    { id: 'c', tokens: ['二分', '二分', '答案', '题目', '练习', '很多', '次'] },
  ];
  it('ranks the better match first and leaves out documents with no match', () => {
    expect(bm25Search(docs, ['边界', '二分']).map((hit) => hit.id)).toEqual(['a', 'c']);
  });
  it('reports how much of the query matched', () => {
    const [first] = bm25Search(docs, ['规划', '未出现的词']);
    expect(first?.coverage).toBeGreaterThan(0);
    expect(first?.coverage).toBeLessThan(1);
    expect(bm25Search(docs, ['动态', '规划'])[0]?.coverage).toBe(1);
  });
  it('returns nothing for empty input', () => {
    expect(bm25Search([], ['a'])).toEqual([]);
    expect(bm25Search(docs, [])).toEqual([]);
  });
});

describe('concepts', () => {
  it('maps aliases to the canonical name', () => {
    expect(conceptsIn('我的 DP 和二分都不太行')).toEqual(expect.arrayContaining(['动态规划', '二分查找']));
    expect(normalizeConcepts(['Binary Search', '堆（优先队列）'])).toEqual(expect.arrayContaining(['二分查找', '堆']));
  });
  it('prefers the longest alias', () => {
    expect(conceptsIn('单调栈')).toEqual(['单调栈']);
    expect(conceptsIn('二叉搜索树')).toEqual(['二叉搜索树']);
  });
  it('needs word boundaries for latin aliases', () => {
    expect(conceptsIn('adpcm')).toEqual([]);
    expect(conceptsIn('sorted')).toEqual([]);
  });
});

describe('retrieve', () => {
  const core0 = { ...DEFAULT_CONFIG, coreSemantic: 0 };
  it('always brings procedural memories and does not count them against topK', () => {
    const memories = [memory('p', '先给提示', { type: 'procedural' }), ...Array.from({ length: 8 }, (_, i) => memory(`s${i}`, '二分 边界', { type: 'episodic' }))];
    const result = retrieve(memories, query('二分 边界'));
    expect(result.filter((item) => item.always).map((item) => item.memory.id)).toEqual(['p']);
    expect(result.filter((item) => !item.always)).toHaveLength(DEFAULT_CONFIG.topK);
  });
  it('always brings the most important semantic memories, up to the limit', () => {
    const memories = [
      memory('goal', '目标是美团', { importance: 5 }),
      memory('lang', '主要用 Go', { importance: 4 }),
      memory('minor', '喜欢喝咖啡', { importance: 1 }),
      memory('gone', '目标是字节', { importance: 5, invalidAt: NOW - DAY }),
    ];
    const config = { ...DEFAULT_CONFIG, coreSemantic: 2 };
    expect(retrieve(memories, query('完全无关的问题'), config).map((item) => item.memory.id)).toEqual(['goal', 'lang']);
    expect(retrieve(memories, query('完全无关的问题'), { ...DEFAULT_CONFIG, coreSemantic: 0 })).toEqual([]);
  });
  it('injects nothing when no memory is relevant', () => {
    const result = retrieve([memory('a', '目标是字节的秋招')], query('滑动窗口怎么写'), core0);
    expect(result).toEqual([]);
  });
  it('finds a memory through the problem tags when the question shares no words with it', () => {
    const weak = memory('weak', '边界老写错', { concepts: ['二分查找'] });
    const other = memory('other', '目标是字节的秋招', { concepts: [] });
    const result = retrieve([weak, other], query('这题怎么下手', { tags: ['Binary Search'] }), core0);
    expect(result.map((item) => item.memory.id)).toEqual(['weak']);
    expect(retrieve([weak, other], query('这题怎么下手', { tags: ['Binary Search'] }), { ...core0, concepts: false })).toEqual([]);
  });
  it('hides invalidated memories unless the question asks about the past', () => {
    const old = memory('old', '主要用 C++ 写题', { invalidAt: NOW - DAY, supersededBy: 'new' });
    const fresh = memory('new', '主要用 Go 写题');
    expect(retrieve([old, fresh], query('我主要用什么语言写题'), core0).map((item) => item.memory.id)).toEqual(['new']);
    expect(retrieve([old, fresh], query('我之前主要用什么语言写题'), core0).map((item) => item.memory.id)).toEqual(expect.arrayContaining(['old', 'new']));
    expect(retrieve([old, fresh], query('我主要用什么语言写题'), { ...core0, validity: false }).map((item) => item.memory.id)).toEqual(expect.arrayContaining(['old', 'new']));
  });
  it('does not always-inject an invalidated procedural memory', () => {
    const old = memory('old', '先给提示', { type: 'procedural', invalidAt: NOW - DAY });
    expect(retrieve([old], query('这题怎么做'))).toEqual([]);
  });
  it('breaks ties with recency and importance', () => {
    const recent = memory('recent', '二分 边界', { validFrom: NOW - DAY });
    const stale = memory('stale', '二分 边界', { validFrom: NOW - 200 * DAY });
    expect(retrieve([stale, recent], query('二分 边界'), core0).map((item) => item.memory.id)).toEqual(['recent', 'stale']);
    const major = memory('major', '二分 边界', { importance: 5 });
    const minor = memory('minor', '二分 边界', { importance: 1 });
    expect(retrieve([minor, major], query('二分 边界'), core0).map((item) => item.memory.id)).toEqual(['major', 'minor']);
  });
  it('finds what held in a month the question names, even with no shared words', () => {
    const march = Date.UTC(2026, 2, 10);
    const old = memory('old', '目标是字节', { validFrom: march, invalidAt: Date.UTC(2026, 4, 1) });
    const fresh = memory('fresh', '目标是美团', { validFrom: Date.UTC(2026, 4, 1) });
    const ids = retrieve([old, fresh], query('三月份我想去哪'), core0).map((item) => item.memory.id);
    expect(ids).toEqual(['old']);
    expect(retrieve([old, fresh], query('三月份我想去哪'), { ...core0, temporal: false })).toEqual([]);
  });
  it('brings back replaced memories for questions about the beginning', () => {
    const old = memory('old', '主要用 C++', { invalidAt: NOW - DAY, supersededBy: 'new' });
    const fresh = memory('new', '主要用 Go');
    expect(retrieve([old, fresh], query('一开始我拿什么写的'), core0).map((item) => item.memory.id)).toEqual(['old']);
  });
  it('does not prefer recent memories when asking about the past', () => {
    const early = memory('early', '二分 边界', { validFrom: NOW - 90 * DAY, invalidAt: NOW - DAY });
    const late = memory('late', '二分 边界', { validFrom: NOW - DAY, importance: 3 });
    expect(retrieve([late, early], query('之前的二分 边界'), core0)[0]?.memory.id).toBe('early');
  });
  it('turns month names into time windows', () => {
    expect(monthWindow('三月份', NOW)).toEqual({ from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 3, 1) });
    expect(monthWindow('12月', NOW)).toEqual({ from: Date.UTC(2025, 11, 1), to: Date.UTC(2026, 0, 1) });
    expect(monthWindow('2024年3月', NOW)).toEqual({ from: Date.UTC(2024, 2, 1), to: Date.UTC(2024, 3, 1) });
    expect(monthWindow('十三月', NOW)).toBeNull();
    expect(monthWindow('没有月份的话', NOW)).toBeNull();
  });
  it('recognises questions about the past', () => {
    expect(askingAboutPast('三月份我想去哪', NOW)).toBe(true);
    expect(askingAboutPast('我之前用什么')).toBe(true);
    expect(askingAboutPast('what did I use last month')).toBe(true);
    expect(askingAboutPast('这题怎么做')).toBe(false);
  });
});
