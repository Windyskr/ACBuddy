import { normalizeConcepts } from '../../entrypoints/lib/memory/concepts';
import { DEFAULT_CONFIG, retrieve, type RetrieveConfig } from '../../entrypoints/lib/memory/retrieve';
import type { MemoryRecord } from '../../entrypoints/lib/memory/types';
import { keywordMemorySelection, problemMessage, recentUserText } from '../baselines/s09';
import { clusterBootstrap, mean, ndcgAtK, percentile, recallAtK, reciprocalRank, seededRandom } from '../metrics';
import { cosine, QUERY_PREFIX, type Embeddings } from '../embed/embed';
import type { DatasetSession, GoldFact, GoldQuestion, Learner, QuestionCategory } from '../types';

const K = 5;
const BM25_ONLY: RetrieveConfig = {
  ...DEFAULT_CONFIG, bigrams: false, concepts: false, recency: false, importance: false, validity: false, temporal: false, alwaysProcedural: false, coreSemantic: 0, minCoverage: 0,
};

/** 消融实验的条件：从只有分词的 BM25 开始，每次多加一个组件；最后一个是完整配置 */
export const CONFIG_LADDER: { name: string; config: RetrieveConfig }[] = [
  { name: 'BM25', config: BM25_ONLY },
  { name: '+字二元组', config: { ...BM25_ONLY, bigrams: true } },
  { name: '+知识点匹配', config: { ...BM25_ONLY, bigrams: true, concepts: true } },
  { name: '+时近性和重要性', config: { ...BM25_ONLY, bigrams: true, concepts: true, recency: true, importance: true } },
  { name: '+失效过滤', config: { ...BM25_ONLY, bigrams: true, concepts: true, recency: true, importance: true, validity: true } },
  { name: '+时间感知', config: { ...BM25_ONLY, bigrams: true, concepts: true, recency: true, importance: true, validity: true, temporal: true } },
  { name: '+程序性常驻', config: { ...BM25_ONLY, bigrams: true, concepts: true, recency: true, importance: true, validity: true, temporal: true, alwaysProcedural: true } },
  { name: '+核心档案', config: { ...BM25_ONLY, bigrams: true, concepts: true, recency: true, importance: true, validity: true, temporal: true, alwaysProcedural: true, coreSemantic: DEFAULT_CONFIG.coreSemantic } },
  { name: '完整（+相关性门槛）', config: DEFAULT_CONFIG },
];

export function factToMemory(fact: GoldFact, at: number): MemoryRecord {
  return {
    id: fact.id, type: fact.type, text: fact.text, concepts: fact.concepts, problemKey: fact.problemKey ?? null, importance: fact.importance,
    evidence: [], sources: [], validFrom: at, invalidAt: null, createdAt: at, supersededBy: null,
  };
}

/** 假设提取和更新都完美时，提问那一刻记忆库应有的样子。检索是单独评测的，不受模型影响 */
export function memoriesAt(learner: Learner, at: number): MemoryRecord[] {
  const sessionAt = new Map(learner.sessions.map((session) => [session.id, Date.parse(session.at)]));
  const visible = learner.facts.filter((fact) => sessionAt.get(fact.session)! <= at);
  const memories = new Map(visible.map((fact) => [fact.id, factToMemory(fact, sessionAt.get(fact.session)!)]));
  for (const fact of visible) {
    const old = fact.supersedes ? memories.get(fact.supersedes) : undefined;
    if (old) {
      old.invalidAt = sessionAt.get(fact.session)!;
      old.supersededBy = fact.id;
    }
  }
  return [...memories.values()];
}

const attemptEventText = (session: DatasetSession) => `${session.at.slice(0, 10)} 做 ${session.problem.title}：${session.attempts!.map((attempt) => attempt.verdict).join(' → ')}（${session.attempts!.at(-1)!.language}）`;

/**
 * 模拟记忆库变大。一个人长期使用时，涨得快的是做题经历，目标、语言这些事实不会有几百条互相矛盾的，
 * 所以 episodic 只用其他学习者的情景记忆和判题事件当干扰项；all 再加上他们的语义事实，是更苛刻的压力测试。
 */
export type NoiseKind = 'episodic' | 'all';
function distractorsFor(learner: Learner, all: Learner[], count: number, noise: NoiseKind): MemoryRecord[] {
  if (!count) return [];
  const others = all.filter((other) => other.id !== learner.id);
  const facts = others.flatMap((other) => other.facts.filter((fact) => fact.type === 'episodic' || (noise === 'all' && fact.type === 'semantic')).map((fact) => ({
    fact, at: Date.parse(other.sessions.find((session) => session.id === fact.session)!.at),
  })));
  // 判题事件和产品里代码生成的情景记忆长得一样
  const events = others.flatMap((other) => other.sessions.filter((session) => session.attempts?.length).map((session) => ({
    at: Date.parse(session.at),
    fact: {
      id: '', session: session.id, type: 'episodic' as const, quote: null, importance: 1, keywords: [],
      text: attemptEventText(session),
      concepts: normalizeConcepts(session.problem.tags),
    },
  })));
  const pool = [...facts, ...events];
  const random = seededRandom(learner.id.split('').reduce((sum, char) => sum + char.charCodeAt(0), count));
  const chosen: MemoryRecord[] = [];
  for (let index = 0; index < count; index++) {
    const { fact, at } = pool[Math.floor(random() * pool.length)]!;
    // validFrom 先存 0–1 的随机数，提问时换算成这个学习者开始使用到提问之间的某个时间
    chosen.push({ ...factToMemory(fact, at), id: `noise-${index}`, problemKey: null, validFrom: random() });
  }
  return chosen;
}

/** 干扰记忆要落在提问之前，否则时近性打分会被「未来」的记忆带偏 */
function placeNoise(noise: MemoryRecord[], start: number, now: number) {
  return noise.map((memory) => {
    const at = start + memory.validFrom * Math.max(0, now - start);
    return { ...memory, validFrom: at, createdAt: at };
  });
}

interface Selection {
  /** 不经检索、每次都带的 */
  always: string[];
  /** 检索出来的，按相关性排序 */
  ranked: string[];
}
interface QuestionResult extends Selection {
  learner: string;
  question: GoldQuestion;
  injectedChars: number;
  ms: number;
}
export type Selector = (memories: MemoryRecord[], question: GoldQuestion, now: number) => Selection;

export const queryText = (question: GoldQuestion) => `${QUERY_PREFIX}${question.query}${question.problem ? ` ${question.problem.title} ${question.problem.tags.join(' ')}` : ''}`;

/** 算向量相似度要用到的全部文字 */
export function embeddingTexts(learners: Learner[]) {
  return learners.flatMap((learner) => [
    ...learner.facts.map((fact) => fact.text),
    ...learner.sessions.filter((session) => session.attempts?.length).map(attemptEventText),
    ...learner.questions.map(queryText),
  ]);
}

export const configSelector = (config: RetrieveConfig, embeddings?: Embeddings): Selector => (memories, question, now) => {
  const queryVector = embeddings?.get(queryText(question));
  const similarity = queryVector
    ? new Map(memories.map((memory) => {
      const vector = embeddings!.get(memory.text);
      return [memory.id, vector ? cosine(queryVector, vector) : -1] as const;
    }))
    : undefined;
  const result = retrieve(memories, {
    text: question.query, tags: question.problem?.tags ?? [], problemKey: question.problem?.key ?? null, now, similarity,
  }, config);
  return {
    always: result.filter((item) => item.always).map((item) => item.memory.id),
    ranked: result.filter((item) => !item.always).map((item) => item.memory.id),
  };
};

/** s09 模型选择失败时的退路：只比对描述，没有模型时能跑的就是它 */
export const s09KeywordSelector: Selector = (memories, question) => {
  const messages = [...(question.problem ? [{ role: 'user', content: problemMessage(question.problem) }] : []), { role: 'user', content: question.query }];
  const records = memories.map((memory) => ({ filename: memory.id, name: '', description: memory.text }));
  return { always: [], ranked: keywordMemorySelection(records, recentUserText(messages), K) };
};
/** 只用向量相似度取前 5 条：很多记忆系统默认的做法 */
export const vectorSelector = (embeddings: Embeddings): Selector => (memories, question) => {
  const queryVector = embeddings.get(queryText(question));
  if (!queryVector) throw new Error(`没有向量：${question.id}，先跑 eval/run.ts embed`);
  const ranked = memories.map((memory) => {
    const vector = embeddings.get(memory.text);
    return { id: memory.id, score: vector ? cosine(queryVector, vector) : -1 };
  }).sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  return { always: [], ranked: ranked.slice(0, K).map((item) => item.id) };
};

/** 不做任何检索，给最近写入的 5 条，看检索到底带来多少提升 */
export const recentSelector: Selector = (memories) => {
  return { always: [], ranked: [...memories].sort((x, y) => y.createdAt - x.createdAt || x.id.localeCompare(y.id)).slice(0, K).map((memory) => memory.id) };
};

function runSelector(selector: Selector, learners: Learner[], pool: Learner[], distractors: number, kind: NoiseKind = 'episodic'): QuestionResult[] {
  const results: QuestionResult[] = [];
  for (const learner of learners) {
    const noise = distractorsFor(learner, pool, distractors, kind);
    const start = Date.parse(learner.sessions[0]!.at);
    for (const question of learner.questions) {
      const now = Date.parse(question.at);
      const memories = [...memoriesAt(learner, now), ...placeNoise(noise, start, now)];
      const started = performance.now();
      const selection = selector(memories, question, now);
      const ms = performance.now() - started;
      const byId = new Map(memories.map((memory) => [memory.id, memory]));
      results.push({
        learner: learner.id, question, ...selection, ms,
        injectedChars: [...selection.always, ...selection.ranked].reduce((sum, id) => sum + (byId.get(id)?.text.length ?? 0), 0),
      });
    }
  }
  return results;
}

export interface RetrievalRow {
  name: string;
  questions: number;
  recall: number;
  recallLow: number;
  recallHigh: number;
  mrr: number;
  ndcg: number;
  /** 更新题里，过期事实被注入的比例 */
  staleRate: number;
  /** 拒答题里，什么都没检索出来的比例 */
  abstainRate: number;
  avgInjected: number;
  avgChars: number;
  p95ms: number;
  byCategory: Partial<Record<QuestionCategory, number>>;
}

export function summarize(name: string, results: QuestionResult[]): RetrievalRow {
  const answerable = results.filter((result) => result.question.relevant.length);
  // 常驻的记忆不占 topK，也不参与排名：相关的算排在最前面，不相关的不挤占排名
  const rankedList = (result: QuestionResult) => [...result.always.filter((id) => result.question.relevant.includes(id)), ...result.ranked];
  const cutoff = (result: QuestionResult) => K + result.always.filter((id) => result.question.relevant.includes(id)).length;
  const recallOf = (result: QuestionResult) => recallAtK(rankedList(result), result.question.relevant, cutoff(result));
  const byLearner = new Map<string, number[]>();
  for (const result of answerable) byLearner.set(result.learner, [...(byLearner.get(result.learner) ?? []), recallOf(result)]);
  const ci = clusterBootstrap([...byLearner.values()]);
  const updates = results.filter((result) => result.question.category === 'update');
  const abstentions = results.filter((result) => result.question.category === 'abstention');
  const byCategory: Partial<Record<QuestionCategory, number>> = {};
  for (const category of new Set(answerable.map((result) => result.question.category))) {
    byCategory[category] = mean(answerable.filter((result) => result.question.category === category).map(recallOf));
  }
  return {
    name,
    questions: results.length,
    recall: ci.mean, recallLow: ci.low, recallHigh: ci.high,
    mrr: mean(answerable.map((result) => reciprocalRank(rankedList(result), result.question.relevant))),
    ndcg: mean(answerable.map((result) => ndcgAtK(rankedList(result), result.question.relevant, cutoff(result)))),
    staleRate: mean(updates.map((result) => (result.question.stale.some((id) => result.ranked.includes(id) || result.always.includes(id)) ? 1 : 0))),
    abstainRate: mean(abstentions.map((result) => (result.ranked.length === 0 ? 1 : 0))),
    avgInjected: mean(results.map((result) => result.always.length + result.ranked.length)),
    avgChars: mean(results.map((result) => result.injectedChars)),
    p95ms: percentile(results.map((result) => result.ms), 95),
    byCategory,
  };
}

export function retrievalSuite(learners: Learner[], pool: Learner[], distractors = 0, noise: NoiseKind = 'episodic', embeddings?: Embeddings | null): RetrievalRow[] {
  const conditions: { name: string; selector: Selector }[] = [
    { name: '最近 5 条', selector: recentSelector },
    { name: 's09 关键词退路', selector: s09KeywordSelector },
    ...CONFIG_LADDER.map(({ name, config }) => ({ name, selector: configSelector(config) })),
    ...(embeddings ? [
      { name: '只用向量', selector: vectorSelector(embeddings) },
      { name: '完整+向量（RRF）', selector: configSelector(DEFAULT_CONFIG, embeddings) },
    ] : []),
  ];
  return conditions.map(({ name, selector }) => summarize(name, runSelector(selector, learners, pool, distractors, noise)));
}

/** 记忆库变大时完整配置的表现 */
export function scaleSuite(learners: Learner[], pool: Learner[], sizes: number[], noise: NoiseKind = 'episodic', config: RetrieveConfig = DEFAULT_CONFIG) {
  return sizes.map((size) => ({ size, row: summarize(`${size}`, runSelector(configSelector(config), learners, pool, size, noise)) }));
}

/** 在开发集上网格搜索权重和门槛，目标是召回率和拒答率的平均。测试集不参与 */
export function tune(learners: Learner[], pool: Learner[]) {
  const best: { score: number; config: RetrieveConfig; row: RetrievalRow }[] = [];
  for (const coreSemantic of [0, 3, 5, 8, 12]) {
    for (const minCoverage of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
      for (const concept of [0.5, 1, 2]) {
        for (const recency of [0, 0.25, 0.5]) {
          for (const importance of [0, 0.25, 0.5]) {
            const config = { ...DEFAULT_CONFIG, coreSemantic, minCoverage, weights: { ...DEFAULT_CONFIG.weights, concept, recency, importance } };
            const row = summarize('tune', runSelector(configSelector(config), learners, pool, 100));
            best.push({ score: (row.recall + (Number.isNaN(row.abstainRate) ? 0 : row.abstainRate)) / 2, config, row });
          }
        }
      }
    }
  }
  return best.sort((x, y) => y.score - x.score).slice(0, 5);
}

/** 向量那一路的门槛，也只在开发集上调 */
export function tuneSimilarity(learners: Learner[], pool: Learner[], embeddings: Embeddings, base: RetrieveConfig = DEFAULT_CONFIG) {
  return [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((minSimilarity) => {
    const row = summarize('tune', runSelector(configSelector({ ...base, minSimilarity }, embeddings), learners, pool, 100));
    return { minSimilarity, score: (row.recall + (Number.isNaN(row.abstainRate) ? 0 : row.abstainRate)) / 2, row };
  });
}
