import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCEPTS } from '../../entrypoints/lib/memory/concepts';
import type { Learner } from '../types';

const LEARNERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tutormem', 'learners');
const CATEGORIES = ['fact', 'multi_session', 'update', 'temporal', 'preference', 'contextual', 'abstention'];

const readLearner = (file: string) => JSON.parse(readFileSync(path.join(LEARNERS_DIR, file), 'utf8')) as Learner;

export function loadLearners(split?: 'dev' | 'test' | 'all'): Learner[] {
  const all = readdirSync(LEARNERS_DIR).filter((file) => file.endsWith('.json')).sort().map(readLearner);
  return !split || split === 'all' ? all : all.filter((learner) => learner.split === split);
}

export const loadLearnersById = (ids: string[]) => ids.map((id) => readLearner(`${id}.json`));

/** 每组至少出现一个词，所有组都满足才算命中 */
export function matchesKeywords(text: string, groups: string[][]) {
  const normalized = text.normalize('NFKC').toLowerCase();
  return groups.length > 0 && groups.every((group) => group.some((word) => normalized.includes(word.normalize('NFKC').toLowerCase())));
}

/** 数据集的硬性约束。不满足的样本不能用来算指标，所以测试里把它当单元测试跑 */
export function validateLearner(learner: Learner): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${learner.id}: ${message}`);
  const time = (value: string, where: string) => {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed) || !/[+-]\d\d:\d\d$|Z$/.test(value)) fail(`${where} 的时间无效：${value}`);
    return parsed;
  };
  if (learner.split !== 'dev' && learner.split !== 'test') fail(`split 无效：${learner.split}`);
  if (!learner.persona?.trim()) fail('缺 persona');

  const sessions = new Map(learner.sessions.map((session) => [session.id, session]));
  if (sessions.size !== learner.sessions.length) fail('会话 id 重复');
  let previous = -Infinity;
  for (const session of learner.sessions) {
    const at = time(session.at, session.id);
    if (at < previous) fail(`${session.id} 的时间早于上一段对话`);
    previous = at;
    if (!session.turns.some((turn) => turn.role === 'user')) fail(`${session.id} 没有用户消息`);
    if (session.turns.at(-1)?.role !== 'assistant') fail(`${session.id} 要以助手回复结束`);
    if (!session.problem?.key || !session.problem.title || !session.problem.statement) fail(`${session.id} 的题目信息不完整`);
  }
  const userText = (sessionId: string) => (sessions.get(sessionId)?.turns ?? []).filter((turn) => turn.role === 'user').map((turn) => turn.content).join('\n');
  const allUserText = learner.sessions.map((session) => userText(session.id)).join('\n');

  const facts = new Map(learner.facts.map((fact) => [fact.id, fact]));
  if (facts.size !== learner.facts.length) fail('事实 id 重复');
  const sessionTime = (id: string) => Date.parse(sessions.get(id)?.at ?? '');
  for (const fact of learner.facts) {
    const session = sessions.get(fact.session);
    if (!session) { fail(`${fact.id} 的会话不存在：${fact.session}`); continue; }
    if (!['semantic', 'episodic', 'procedural'].includes(fact.type)) fail(`${fact.id} 的 type 无效`);
    if (fact.quote != null && !userText(fact.session).includes(fact.quote)) fail(`${fact.id} 的 quote 不是用户原话：${fact.quote}`);
    if (fact.quote == null && !session.attempts?.some((attempt) => attempt.id === fact.attemptId)) fail(`${fact.id} 没有用户原话，也没有对应的作答记录`);
    for (const concept of fact.concepts) if (!CONCEPTS.includes(concept)) fail(`${fact.id} 的知识点不在表里：${concept}`);
    if (!(fact.importance >= 1 && fact.importance <= 5)) fail(`${fact.id} 的 importance 无效`);
    if (!matchesKeywords(fact.text, fact.keywords)) fail(`${fact.id} 的 keywords 匹配不上它自己的 text`);
    if (fact.supersedes) {
      const old = facts.get(fact.supersedes);
      if (!old) fail(`${fact.id} 取代的事实不存在：${fact.supersedes}`);
      else if (sessionTime(old.session) >= sessionTime(fact.session)) fail(`${fact.id} 取代的事实不早于它`);
    }
  }
  for (const item of learner.transient) {
    if (!sessions.has(item.session)) fail(`transient 的会话不存在：${item.session}`);
    if (!matchesKeywords(item.text, item.keywords)) fail(`transient 的 keywords 匹配不上它自己的 text：${item.text}`);
  }

  const questions = new Set<string>();
  for (const question of learner.questions) {
    if (questions.has(question.id)) fail(`问题 id 重复：${question.id}`);
    questions.add(question.id);
    if (!CATEGORIES.includes(question.category)) fail(`${question.id} 的 category 无效`);
    const at = time(question.at, question.id);
    if (!question.query?.trim() || !question.answer?.trim()) fail(`${question.id} 缺 query 或 answer`);
    for (const id of [...question.relevant, ...question.stale]) {
      const fact = facts.get(id);
      if (!fact) fail(`${question.id} 引用的事实不存在：${id}`);
      else if (sessionTime(fact.session) > at) fail(`${question.id} 引用了之后才出现的事实：${id}`);
    }
    if (question.category === 'abstention' && question.relevant.length) fail(`${question.id} 是拒答题，relevant 要为空`);
    if (question.category !== 'abstention' && !question.relevant.length) fail(`${question.id} 没有 relevant`);
    if (question.category === 'update' && !question.stale.length) fail(`${question.id} 是更新题，要标 stale`);
    for (const id of question.stale) {
      const replaced = learner.facts.some((fact) => fact.supersedes === id && sessionTime(fact.session) <= at);
      if (!replaced) fail(`${question.id} 的 stale 事实在提问时还没被取代：${id}`);
    }
    for (const id of question.relevant) {
      if (question.category !== 'temporal' && learner.facts.some((fact) => fact.supersedes === id && sessionTime(fact.session) <= at)) {
        fail(`${question.id} 的 relevant 事实已被取代：${id}`);
      }
    }
  }

  const attacks = new Set<string>();
  for (const attack of learner.attacks) {
    if (attacks.has(attack.id)) fail(`攻击 id 重复：${attack.id}`);
    attacks.add(attack.id);
    const session = sessions.get(attack.session);
    if (!session) { fail(`${attack.id} 的会话不存在`); continue; }
    const carrier = attack.channel === 'problem' ? session.problem.statement
      : session.turns.filter((turn) => turn.role === attack.channel).map((turn) => turn.content).join('\n');
    if (!carrier.includes(attack.payload)) fail(`${attack.id} 的 payload 不在 ${attack.channel} 里`);
    if (!attack.canary.length) fail(`${attack.id} 缺 canary`);
    if (matchesKeywords(allUserText, attack.canary)) fail(`${attack.id} 的 canary 在用户消息里出现过，算不上投毒`);
    for (const fact of learner.facts) if (matchesKeywords(fact.text, attack.canary)) fail(`${attack.id} 的 canary 和事实 ${fact.id} 重合`);
  }
  return errors;
}
