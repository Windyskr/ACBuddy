import { bm25Search } from './bm25';
import { conceptsIn, normalizeConcepts } from './concepts';
import { tokenize } from './tokenize';
import type { MemoryRecord } from './types';

export interface RetrieveQuery {
  text: string;
  /** 当前题目的标签和键，没开题目时为空 */
  tags: string[];
  problemKey: string | null;
  now: number;
  /**
   * 查询和每条记忆的向量相似度（-1 到 1）。插件里没有向量，这个字段只给评测的对照实验用：
   * 实验显示加向量没有提升（docs/memory-system.md），所以没有把 24 MB 的模型放进插件。
   */
  similarity?: Map<string, number>;
}

export interface RetrieveConfig {
  topK: number;
  bigrams: boolean;
  /** 题目标签和查询里的知识点匹配记忆的知识点 */
  concepts: boolean;
  recency: boolean;
  importance: boolean;
  /** 失效的记忆默认不返回；查询在问过去时才放出来 */
  validity: boolean;
  /** 问过去时按时间找：提到的月份和记忆的有效期重叠就算相关，已失效的记忆也都进候选 */
  temporal: boolean;
  /** 程序性记忆（怎么辅导这个人）不经过检索，每次都带 */
  alwaysProcedural: boolean;
  /**
   * 核心档案（MemGPT 的 core memory）：最重要的几条语义记忆也每次都带，条数有上限。
   * 目标、语言这类事实被问到时往往换了说法，词面检索找不到，靠它兜住。
   */
  coreSemantic: number;
  /** 词面覆盖度低于它、又没有知识点或题目匹配时不算相关；都不相关就什么都不注入 */
  minCoverage: number;
  /** 向量相似度达到它也算相关，只在有向量时生效 */
  minSimilarity: number;
  weights: { concept: number; sameProblem: number; recency: number; importance: number; time: number };
  /** 时近性半衰的天数 */
  halfLifeDays: number;
}

export const DEFAULT_CONFIG: RetrieveConfig = {
  topK: 5,
  bigrams: true,
  concepts: true,
  recency: true,
  importance: true,
  validity: true,
  temporal: true,
  alwaysProcedural: true,
  coreSemantic: 8,
  // 下面几个数在开发集上用 eval/run.ts tune 搜索确定，测试集不参与
  minCoverage: 0.15,
  minSimilarity: 0.65,
  weights: { concept: 0.5, sameProblem: 0.5, recency: 0.25, importance: 0.25, time: 1 },
  halfLifeDays: 30,
};

export interface RetrievedMemory {
  memory: MemoryRecord;
  score: number;
  /** 程序性记忆或核心档案，不是检索来的 */
  always: boolean;
}

const DAY_MS = 86_400_000;
const MONTH = /(?:(\d{4})\s*年\s*)?([一二三四五六七八九十]{1,3}|\d{1,2})\s*月/;
const PAST_CUE = /之前|以前|原来|当时|当初|那时|那会|曾经|起初|最早|上个月|上周|上次|去年|年初|前几[天周]|几[天周]前|个月前|刚开始|刚入门|一开始|\b(?:before|previously|used to|earlier|at first|last (?:week|month|year)|ago)\b/i;
const CHINESE_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

/** 文字里提到的月份换算成时间范围。没写年份时取不晚于现在的那一年 */
export function monthWindow(text: string, now: number) {
  const match = MONTH.exec(text);
  if (!match) return null;
  const month = CHINESE_DIGITS[match[2]!] ?? Number(match[2]);
  if (!(month >= 1 && month <= 12)) return null;
  const today = new Date(now);
  const year = match[1] ? Number(match[1]) : month - 1 > today.getUTCMonth() ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
  return { from: Date.UTC(year, month - 1, 1), to: Date.UTC(year, month, 1) };
}

export function askingAboutPast(text: string, now?: number) {
  if (PAST_CUE.test(text)) return true;
  const window = now === undefined ? null : monthWindow(text, now);
  return !!window && window.from <= now!;
}

export function retrieve(memories: MemoryRecord[], query: RetrieveQuery, config: RetrieveConfig = DEFAULT_CONFIG): RetrievedMemory[] {
  const past = askingAboutPast(query.text, query.now);
  const includeInvalid = !config.validity || past;
  const window = config.temporal && past ? monthWindow(query.text, query.now) : null;
  const active = memories.filter((memory) => includeInvalid || memory.invalidAt == null || memory.invalidAt > query.now);
  const current = active.filter((memory) => memory.invalidAt == null);
  const always = [
    ...(config.alwaysProcedural ? current.filter((memory) => memory.type === 'procedural') : []),
    ...current.filter((memory) => memory.type === 'semantic')
      .sort((x, y) => y.importance - x.importance || y.validFrom - x.validFrom || x.id.localeCompare(y.id))
      .slice(0, config.coreSemantic),
  ];
  const alwaysIds = new Set(always.map((memory) => memory.id));
  const candidates = active.filter((memory) => !alwaysIds.has(memory.id));

  const hits = new Map(bm25Search(
    candidates.map((memory) => ({ id: memory.id, tokens: tokenize(memory.text, { bigrams: config.bigrams }) })),
    tokenize(query.text, { bigrams: config.bigrams }),
  ).map((hit) => [hit.id, hit]));
  const topScore = Math.max(0, ...[...hits.values()].map((hit) => hit.score));
  // 词面和向量两路按名次融合（RRF），两边的分数不在一个尺度上，不能直接相加
  const fused = new Map<string, number>();
  if (query.similarity) {
    const lexical = [...hits.values()].sort((x, y) => y.score - x.score).map((hit) => hit.id);
    const semantic = candidates.map((memory) => memory.id).sort((x, y) => (query.similarity!.get(y) ?? -1) - (query.similarity!.get(x) ?? -1));
    for (const list of [lexical, semantic]) list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank)));
  }
  const topFused = Math.max(0, ...fused.values());
  const queryConcepts = config.concepts
    ? new Set([...normalizeConcepts(query.tags), ...conceptsIn(query.text)])
    : new Set<string>();

  const ranked: RetrievedMemory[] = [];
  for (const memory of candidates) {
    const hit = hits.get(memory.id);
    const conceptOverlap = memory.concepts.filter((concept) => queryConcepts.has(concept)).length;
    const sameProblem = config.concepts && query.problemKey != null && memory.problemKey === query.problemKey;
    const inWindow = !!window && memory.validFrom < window.to && (memory.invalidAt ?? query.now) >= window.from;
    const history = config.temporal && past && memory.invalidAt != null;
    const similar = (query.similarity?.get(memory.id) ?? -1) >= config.minSimilarity;
    // 时近性和重要性只调整顺序，不能让一条无关的记忆被选中
    if ((hit?.coverage ?? 0) < config.minCoverage && !similar && !conceptOverlap && !sameProblem && !inWindow && !history) continue;
    const { weights } = config;
    let score = query.similarity ? (fused.get(memory.id) ?? 0) / (topFused || 1) : topScore ? (hit?.score ?? 0) / topScore : 0;
    if (conceptOverlap) score += weights.concept * Math.min(1, conceptOverlap / Math.max(1, memory.concepts.length));
    if (sameProblem) score += weights.sameProblem;
    if (inWindow || history) score += weights.time;
    // 问过去时，越新反而不是优势
    if (config.recency && !past) score += weights.recency * 2 ** (-(query.now - memory.validFrom) / DAY_MS / config.halfLifeDays);
    if (config.importance) score += weights.importance * (memory.importance - 1) / 4;
    ranked.push({ memory, score, always: false });
  }
  ranked.sort((x, y) => y.score - x.score || x.memory.id.localeCompare(y.memory.id));
  return [
    ...always.map((memory) => ({ memory, score: 0, always: true })),
    ...ranked.slice(0, config.topK),
  ];
}
