import { CONCEPTS, conceptsIn } from './concepts';
import { tokenize } from './tokenize';
import type { MemoryType } from './types';

/** 模型提出的一条候选记忆，写入前要过这里的检查 */
export interface Candidate {
  type: MemoryType;
  text: string;
  /** 用户原话 */
  quote: string;
  concepts: string[];
  importance: number;
  scope: 'persistent' | 'current_task';
  /** 只和当前这道题有关 */
  problemSpecific: boolean;
}

export type GateReason = 'schema' | 'current_task' | 'temporary' | 'no_quote' | 'quote_not_from_user' | 'unsupported';

const TYPES: MemoryType[] = ['semantic', 'episodic', 'procedural'];
/** 一条记忆就是一句话，太长说明模型没按要求写。也是同步接口的长度限制以内 */
export const MAX_MEMORY_CHARS = 500;
// 记忆本身带这些词，说明模型把只对当前有效的内容当成了长期事实。原话里出现没关系（「这题别给代码，以后都这样」）
const TEMPORARY_MARKERS = [
  'this session', 'current session', 'this turn', 'current turn', 'this task', 'current task', 'this problem', 'for now', 'just this time', 'today only',
  '本次', '这次', '此次', '这题', '这道题', '本题', '当前会话', '当前任务', '当前题目', '这一轮', '暂时', '今天', '刚才',
];
// 比对证据时不算内容的词：任何一条记忆都可能带，任何一段对话也都可能有
const GENERIC_WORDS = new Set([
  '用户', '希望', '喜欢', '需要', '想要', '认为', '觉得', '表示', '主要', '经常', '总是', '一直', '容易', '目前', '现在', '已经', '可以', '应该', '回答', '时候',
  '刷题', '写题', '做题', '题目', '题', '写', '做', '用', '给', '讲', '说', '看', '想', '对', '上', '中', '时', '后', '前', '以后', '之后', 'user',
]);

const squeeze = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
// 记忆这边只取词：字二元组跨词切（「户喜」）是噪声。证据那边带上二元组，分词不一致也能对上
const contentTokens = (text: string) => [...new Set(tokenize(text, { bigrams: false }).filter((token) => !GENERIC_WORDS.has(token)))];

/** 记忆内容有多少出现在证据里，0–1。模型被骗时能编出一条记忆再随便引一句真话，这里挡的就是这种 */
export function supportScore(text: string, evidence: string) {
  const claimed = contentTokens(text);
  if (!claimed.length) return 0;
  const available = new Set(tokenize(evidence));
  return claimed.filter((token) => available.has(token)).length / claimed.length;
}

/** 找出包含这句原话的用户消息。比对时忽略空白、标点和大小写，模型摘录时常会改动这些 */
export function findQuotedMessage(quote: string, userMessages: string[]) {
  const wanted = squeeze(quote);
  if (wanted.length < 2) return null;
  return userMessages.find((message) => squeeze(message).includes(wanted)) ?? null;
}

export interface GateOptions {
  /** 证据校验：原话必须出现在用户消息里，且能支持记忆内容 */
  evidence: boolean;
  /** 记忆内容在证据里出现的比例下限，在开发集上标定 */
  minSupport: number;
}
// 0.25 在开发集上标定：几乎不误伤真实事实，又能挡住伪造证据
export const DEFAULT_GATE: GateOptions = { evidence: true, minSupport: 0.25 };

export function parseCandidate(raw: unknown): Candidate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (!TYPES.includes(item.type as MemoryType) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_MEMORY_CHARS) return null;
  if (typeof item.quote !== 'string') return null;
  const concepts = Array.isArray(item.concepts) ? item.concepts.filter((concept): concept is string => CONCEPTS.includes(concept as string)) : [];
  const importance = typeof item.importance === 'number' ? Math.min(5, Math.max(1, Math.round(item.importance))) : 3;
  return {
    type: item.type as MemoryType,
    text: item.text.trim(),
    quote: item.quote.trim(),
    // 模型漏标的知识点从文字里补，检索靠它匹配题目标签
    concepts: [...new Set([...concepts, ...conceptsIn(item.text)])],
    importance,
    scope: item.scope === 'current_task' ? 'current_task' : 'persistent',
    problemSpecific: item.problem_specific === true,
  };
}

/** 写入长期记忆前的最后一道检查，不依赖模型，模型被题面里的文字骗了也能挡住 */
export function checkCandidate(candidate: Candidate, userMessages: string[], options: GateOptions = DEFAULT_GATE): GateReason | null {
  if (candidate.scope !== 'persistent') return 'current_task';
  const lowered = candidate.text.toLowerCase();
  if (TEMPORARY_MARKERS.some((marker) => lowered.includes(marker))) return 'temporary';
  if (!options.evidence) return null;
  if (!candidate.quote) return 'no_quote';
  const message = findQuotedMessage(candidate.quote, userMessages);
  if (!message) return 'quote_not_from_user';
  if (supportScore(candidate.text, message) < options.minSupport) return 'unsupported';
  return null;
}
