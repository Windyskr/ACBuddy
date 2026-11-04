import type { AgentMessage } from '../../entrypoints/lib/agent';
import { estimateTokens, requestMessages, trimHistory } from '../../entrypoints/lib/context';
import { seededRandom } from '../metrics';

// 提示缓存的模拟：模型服务只缓存请求开头逐字相同的部分，所以每次请求能命中多少，取决于它和上一次请求的公共开头有多长。
// 这里按消息比较公共开头（一条消息里只要有一处不同就整条算没命中，比服务端按 token 算略保守），
// 用插件里真实的 trimHistory 和 requestMessages 拼请求，和改之前的做法对比。

const SYSTEM_TOKENS = 1500;
const NOW = Date.UTC(2026, 10, 2);

interface Turn {
  question: string;
  memory: string[];
  code: string;
  answer: string;
}

/** 一段对话：每轮先提问，模型读一次代码再回答。记忆每轮检索出 6 条常驻的，再加 0–2 条和这次问题相关的 */
function conversation(turns: number, seed: number): Turn[] {
  const random = seededRandom(seed);
  const pick = (low: number, high: number) => Math.floor(low + random() * (high - low));
  const core = Array.from({ length: 6 }, (_, index) => `常驻记忆${index}：${'用户的目标和习惯'.repeat(3)}`);
  return Array.from({ length: turns }, (_, index) => ({
    question: `第${index + 1}个问题：${'这里为什么不对'.repeat(pick(1, 4))}`,
    memory: [...core, ...Array.from({ length: pick(0, 3) }, () => `相关记忆${pick(0, 40)}：${'以前在这类题上出过错'.repeat(2)}`)],
    code: `class Solution { /* ${'x'.repeat(pick(1500, 6000))} */ }`,
    answer: `第${index + 1}个回答：${'先检查边界条件再看循环'.repeat(pick(20, 60))}`,
  }));
}

const block = (memories: string[]) => (memories.length ? `<memory>\n${memories.join('\n')}\n</memory>` : '');

interface Strategy {
  name: string;
  /** 这一轮提问前怎么处理历史，返回要保存的历史 */
  prepare(history: AgentMessage[], turn: Turn): AgentMessage[];
  /** 发出去的消息 */
  request(history: AgentMessage[], turn: Turn): AgentMessage[];
}

/** 改之前：每轮都把两轮之前的工具结果换成占位，记忆只拼在最新一条提问前 */
function oldRequest(history: AgentMessage[], turn: Turn) {
  let userTurns = 0;
  let cut = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.role === 'user' && !history[index]!.kind && ++userTurns === 2) { cut = index; break; }
  }
  const latest = history.findLastIndex((message) => message.role === 'user' && !message.kind);
  return history.map((message, index) => {
    if (index < cut && message.role === 'tool') return { ...message, content: '{"omitted":true}' };
    if (index === latest) return { ...message, content: `${block(turn.memory)}\n\n${message.content}` };
    return message;
  });
}

/** 现在：记忆跟着提问存下来，只注入这段对话里没给过的 */
function withPersistedMemory(history: AgentMessage[], turn: Turn) {
  const present = new Set(history.flatMap((message) => message.usedMemories?.map((item) => item.text) ?? []));
  const fresh = turn.memory.filter((item) => !present.has(item));
  const last = history.at(-1)!;
  return [...history.slice(0, -1), { ...last, memoryText: block(fresh) || undefined, usedMemories: turn.memory.map((text) => ({ id: text, text })) }];
}

/** 新做法，换一个裁剪阈值 */
export const thresholdStrategy = (minTokens: number): Strategy => ({
  name: `攒够 ${minTokens} 再裁`,
  prepare: (history, turn) => trimHistory(withPersistedMemory(history, turn), NOW, minTokens),
  request: (history) => requestMessages(history),
});

export const CACHE_STRATEGIES: Strategy[] = [
  { name: '改之前：每轮裁、记忆只在最新提问', prepare: (history) => history, request: oldRequest },
  { name: '只改记忆', prepare: withPersistedMemory, request: (history) => {
    // 记忆按新做法存，裁剪还是每轮都裁
    const sent = requestMessages(history);
    let userTurns = 0;
    let cut = 0;
    for (let index = sent.length - 1; index >= 0; index--) {
      if (sent[index]!.role === 'user' && !sent[index]!.kind && ++userTurns === 2) { cut = index; break; }
    }
    return sent.map((message, index) => (index < cut && message.role === 'tool' ? { ...message, content: '{"omitted":true}' } : message));
  } },
  { name: '只改裁剪', prepare: (history) => trimHistory(history, NOW), request: (history, turn) => {
    const sent = requestMessages(history);
    const latest = sent.findLastIndex((message) => message.role === 'user' && !message.kind);
    return sent.map((message, index) => (index === latest ? { ...message, content: `${block(turn.memory)}\n\n${message.content}` } : message));
  } },
  { name: '改之后：攒够再裁、记忆存进历史', prepare: (history, turn) => trimHistory(withPersistedMemory(history, turn), NOW), request: (history) => requestMessages(history) },
  { name: '参照：从不裁、记忆存进历史', prepare: withPersistedMemory, request: (history) => requestMessages(history) },
];

const same = (a: AgentMessage, b: AgentMessage) => JSON.stringify(a) === JSON.stringify(b);

export interface CacheRow {
  name: string;
  turns: number;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  /** 每轮第一次请求要原价处理的 token（首字延迟主要看它） */
  uncachedPerQuestion: number;
  /** 最后一次请求的大小 */
  lastRequestTokens: number;
  /**
   * 相对费用：没命中的按 1 算，命中的按缓存价算。writeExtra 是写入缓存比原价多收的部分
   * （Claude 1 小时缓存写入是原价的 2 倍，就是 1）：没命中的都会写进缓存，按 1 + writeExtra 算
   */
  cost: (cacheReadPrice: number, writeExtra?: number) => number;
}

export function simulateCache(strategy: Strategy, turns: number, seed = 7): CacheRow {
  const script = conversation(turns, seed);
  let history: AgentMessage[] = [{ role: 'user', kind: 'problem', content: `当前题目信息\n${'题面'.repeat(400)}` }];
  let previous: AgentMessage[] = [];
  let inputTokens = 0;
  let cachedTokens = 0;
  let firstUncached = 0;
  let lastRequestTokens = 0;
  const send = (sent: AgentMessage[], first: boolean) => {
    let common = 0;
    while (common < sent.length && common < previous.length && same(sent[common]!, previous[common]!)) common++;
    const total = SYSTEM_TOKENS + estimateTokens(sent);
    const cached = previous.length ? SYSTEM_TOKENS + estimateTokens(sent.slice(0, common)) : 0;
    inputTokens += total;
    cachedTokens += cached;
    if (first) firstUncached += total - cached;
    lastRequestTokens = total;
    previous = sent;
  };
  script.forEach((turn, index) => {
    history = strategy.prepare([...history, { role: 'user', content: turn.question }], turn);
    send(strategy.request(history, turn), true);
    history = [...history,
      { role: 'assistant', content: null, tool_calls: [{ id: `c${index}`, type: 'function', function: { name: 'get_code', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `c${index}`, content: JSON.stringify({ code: turn.code }) }];
    send(strategy.request(history, turn), false);
    history = [...history, { role: 'assistant', content: turn.answer, trace: { model: 'm', totalMs: 1, endedAt: NOW - 60_000, steps: [], tools: [] } }];
  });
  return {
    name: strategy.name, turns, requests: turns * 2, inputTokens, cachedTokens,
    uncachedPerQuestion: firstUncached / turns, lastRequestTokens,
    cost: (price, writeExtra = 0) => (inputTokens - cachedTokens) * (1 + writeExtra) + price * cachedTokens,
  };
}
