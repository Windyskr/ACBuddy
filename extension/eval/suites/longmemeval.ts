import { readFileSync } from 'node:fs';
import { bm25Search } from '../../entrypoints/lib/memory/bm25';
import { tokenize } from '../../entrypoints/lib/memory/tokenize';
import { clusterBootstrap, recallAtK, seededRandom } from '../metrics';
import type { DatasetProblem, GoldQuestion, Learner, QuestionCategory } from '../types';

// LongMemEval（Wu 等，ICLR 2025）的适配。数据集不进仓库，放在 eval/.cache/ 下：
// https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
export interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string | number;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: { role: 'user' | 'assistant'; content: string }[][];
}

export const loadLongMemEval = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as LmeQuestion[];

/** 日期格式是 2023/05/20 (Sat) 02:21，没有时区，统一按 UTC 算，只用来排先后和算间隔 */
export function parseLmeDate(value: string) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}):(\d{2})/.exec(value);
  if (!match) throw new Error(`日期格式不对：${value}`);
  const [, year, month, day, hour, minute] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))).toISOString();
}

export const isAbstention = (question: LmeQuestion) => question.question_id.endsWith('_abs');

export function categoryOf(question: LmeQuestion): QuestionCategory {
  if (isAbstention(question)) return 'abstention';
  switch (question.question_type) {
    case 'temporal-reasoning': return 'temporal';
    case 'knowledge-update': return 'update';
    case 'single-session-preference': return 'preference';
    case 'multi-session': return 'multi_session';
    default: return 'fact';
  }
}

/** 按题型分层抽样，每类数量尽量相同。种子固定，抽到的题可以复现 */
export function sampleQuestions(all: LmeQuestion[], count: number, seed = 42) {
  const groups = new Map<string, LmeQuestion[]>();
  for (const question of all) groups.set(question.question_type, [...(groups.get(question.question_type) ?? []), question]);
  const random = seededRandom(seed);
  const shuffled = [...groups.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, group]) => {
    const copy = [...group];
    for (let index = copy.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [copy[index], copy[other]] = [copy[other]!, copy[index]!];
    }
    return copy;
  });
  const chosen: LmeQuestion[] = [];
  for (let round = 0; chosen.length < count && shuffled.some((group) => group.length > round); round++) {
    for (const group of shuffled) {
      if (group[round] && chosen.length < count) chosen.push(group[round]!);
    }
  }
  return chosen;
}

const NO_PROBLEM: DatasetProblem = { key: 'chat', title: '日常对话', tags: [], statement: '' };

/** 每道题有自己的一堆历史对话，转成只有一个问题的学习者，复用同一套流程 */
export function toLearner(question: LmeQuestion): Learner {
  const gold: GoldQuestion = {
    id: question.question_id, at: parseLmeDate(question.question_date), problem: null, query: question.question,
    category: categoryOf(question), relevant: [], stale: [], answer: String(question.answer),
  };
  const sessions = question.haystack_sessions.map((turns, index) => ({
    id: question.haystack_session_ids[index]!, at: parseLmeDate(question.haystack_dates[index]!), problem: NO_PROBLEM,
    turns: turns.map(({ role, content }) => ({ role, content })),
  })).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  return { id: question.question_id, split: 'test', persona: '', sessions, facts: [], transient: [], questions: [gold], attacks: [] };
}

/**
 * 不调用模型的检索对照：直接在原始对话上做会话级 BM25，看证据会话排不排得进前几。
 * 用来校验分词和 BM25 在外部数据上是正常的，不是记忆系统的最终指标。
 */
export function sessionRetrieval(questions: LmeQuestion[], { userOnly = true, k = 5 } = {}) {
  const answerable = questions.filter((question) => !isAbstention(question) && question.answer_session_ids.length);
  const byType = new Map<string, number[]>();
  for (const question of answerable) {
    const docs = question.haystack_sessions.map((turns, index) => ({
      id: question.haystack_session_ids[index]!,
      tokens: tokenize(turns.filter((turn) => !userOnly || turn.role === 'user').map((turn) => turn.content).join('\n')),
    }));
    const ranked = bm25Search(docs, tokenize(question.question)).map((hit) => hit.id);
    byType.set(question.question_type, [...(byType.get(question.question_type) ?? []), recallAtK(ranked, question.answer_session_ids, k)]);
  }
  const overall = clusterBootstrap([...byType.values()]);
  return { questions: answerable.length, recall: overall.mean, byType: Object.fromEntries([...byType].map(([type, values]) => [type, values.reduce((sum, value) => sum + value, 0) / values.length])) };
}
