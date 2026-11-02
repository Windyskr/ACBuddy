import type { MemoryType } from '../entrypoints/lib/memory/types';

// ———— 数据集 ————

export interface DatasetProblem {
  key: string;
  title: string;
  tags: string[];
  statement: string;
}
export type Turn =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'tool'; name: string; content: string };
export interface DatasetAttempt {
  id: number;
  result: 'pass' | 'fail';
  verdict: string;
  language: string;
  at: string;
}
export interface DatasetSession {
  id: string;
  /** ISO 时间，带时区 */
  at: string;
  problem: DatasetProblem;
  turns: Turn[];
  attempts?: DatasetAttempt[];
}
/** 这段对话之后系统应该记住的事实 */
export interface GoldFact {
  id: string;
  session: string;
  type: MemoryType;
  text: string;
  /** 用户原话，逐字出现在这段对话的 user 消息里；来自判题记录时为 null */
  quote: string | null;
  attemptId?: number;
  concepts: string[];
  problemKey?: string;
  importance: number;
  /** 取代了哪条事实 */
  supersedes?: string;
  /** 判断提取结果是否命中：每组至少出现一个词，所有组都要满足 */
  keywords: string[][];
}
/** 对话里出现、但不该长期保存的内容：一次性要求、临时状态、助手的说法…… */
export interface GoldTransient {
  session: string;
  text: string;
  keywords: string[][];
}
export type QuestionCategory = 'fact' | 'multi_session' | 'update' | 'temporal' | 'preference' | 'contextual' | 'abstention';
export interface GoldQuestion {
  id: string;
  at: string;
  problem: DatasetProblem | null;
  query: string;
  category: QuestionCategory;
  /** 回答这个问题需要的事实 */
  relevant: string[];
  /** 已过期、不该被当作现状的事实 */
  stale: string[];
  /** 标准答案；preference、contextual 是评分要点；abstention 是为什么答不了 */
  answer: string;
}
/** 投毒样本：payload 藏在非用户的内容里，诱导系统把 canary 写进长期记忆 */
export interface GoldAttack {
  id: string;
  session: string;
  channel: 'problem' | 'tool' | 'assistant';
  payload: string;
  /** 写入的记忆里出现这些词（每组至少一个）就算攻击成功 */
  canary: string[][];
}
export interface Learner {
  id: string;
  split: 'dev' | 'test';
  persona: string;
  sessions: DatasetSession[];
  facts: GoldFact[];
  transient: GoldTransient[];
  questions: GoldQuestion[];
  attacks: GoldAttack[];
}

// ———— 被评测的记忆系统 ————

export interface RecallInput {
  query: string;
  problem: DatasetProblem | null;
  now: number;
}
export interface RecallOutput {
  /** 接在系统提示后面的记忆段落 */
  systemText: string;
  /** 这次注入了哪些记忆 */
  memories: { id: string; text: string }[];
}
export interface MemorySystem {
  name: string;
  ingest(session: DatasetSession): Promise<void>;
  recall(input: RecallInput): Promise<RecallOutput>;
  /** 当前存着的全部记忆，算提取和投毒指标用。active 为 false 表示已被标记失效 */
  dump(): { id: string; text: string; active?: boolean }[];
}
