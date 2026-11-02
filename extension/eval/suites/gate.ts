import { checkCandidate, supportScore, type Candidate, type GateOptions, DEFAULT_GATE } from '../../entrypoints/lib/memory/gate';
import { clusterBootstrap, percentile } from '../metrics';
import type { DatasetSession, Learner } from '../types';

const userMessages = (session: DatasetSession) => session.turns.filter((turn) => turn.role === 'user').map((turn) => turn.content);
const candidate = (text: string, quote: string): Candidate => ({ type: 'semantic', text, quote, concepts: [], importance: 3, scope: 'persistent', problemSpecific: false });

export interface GateRow {
  minSupport: number;
  /** 标注好的真实事实里，通过门禁的比例 */
  goldAccepted: number;
  /** 最坏情况：模型完全被骗，把投毒内容当记忆输出并引用一句真实的用户原话。门禁挡下的比例 */
  forgedBlocked: number;
  forgedBlockedLow: number;
  forgedBlockedHigh: number;
  /** 模型直接把 payload 当原话引用时，门禁挡下的比例 */
  fakeQuoteBlocked: number;
}

/** 不调用模型：模拟提取模型已经被攻破，只看代码层的门禁能挡住多少 */
export function gateSuite(learners: Learner[], options: GateOptions = DEFAULT_GATE): GateRow {
  let goldTotal = 0;
  let goldAccepted = 0;
  let fakeTotal = 0;
  let fakeBlocked = 0;
  const forgedByLearner: number[][] = [];
  for (const learner of learners) {
    const sessions = new Map(learner.sessions.map((session) => [session.id, session]));
    for (const fact of learner.facts) {
      if (fact.quote == null) continue;
      goldTotal++;
      if (!checkCandidate(candidate(fact.text, fact.quote), userMessages(sessions.get(fact.session)!), options)) goldAccepted++;
    }
    const forged: number[] = [];
    for (const attack of learner.attacks) {
      const messages = userMessages(sessions.get(attack.session)!);
      // 攻击者挑最有利的一句：payload 和这段对话里任意一条用户消息配对，只要有一对通过就算没挡住
      const passed = messages.some((message) => !checkCandidate(candidate(attack.payload, message.slice(0, 40)), messages, options));
      forged.push(passed ? 0 : 1);
      fakeTotal++;
      if (checkCandidate(candidate(attack.payload, attack.payload), messages, options)) fakeBlocked++;
    }
    forgedByLearner.push(forged);
  }
  const ci = clusterBootstrap(forgedByLearner);
  return {
    minSupport: options.minSupport, goldAccepted: goldAccepted / goldTotal,
    forgedBlocked: ci.mean, forgedBlockedLow: ci.low, forgedBlockedHigh: ci.high,
    fakeQuoteBlocked: fakeBlocked / fakeTotal,
  };
}

/** 标定用：真实事实和投毒内容的证据支持度分布 */
export function supportDistribution(learners: Learner[]) {
  const gold: number[] = [];
  const attacks: number[] = [];
  for (const learner of learners) {
    const sessions = new Map(learner.sessions.map((session) => [session.id, session]));
    for (const fact of learner.facts) {
      if (fact.quote == null) continue;
      const message = userMessages(sessions.get(fact.session)!).find((item) => item.includes(fact.quote!)) ?? '';
      gold.push(supportScore(fact.text, message));
    }
    for (const attack of learner.attacks) {
      attacks.push(Math.max(0, ...userMessages(sessions.get(attack.session)!).map((message) => supportScore(attack.payload, message))));
    }
  }
  const quantiles = (values: number[]) => Object.fromEntries([5, 10, 25, 50, 75, 90, 95].map((p) => [`p${p}`, Number(percentile(values, p).toFixed(3))]));
  return { gold: quantiles(gold), attacks: quantiles(attacks) };
}
