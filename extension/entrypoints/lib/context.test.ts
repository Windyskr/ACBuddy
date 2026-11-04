import { describe, expect, it } from 'vitest';
import type { AgentMessage } from './agent';
import { completedMessages } from './agent';
import { modelRequest } from './agent-protocol';
import {
  CACHE_COLD_MS, capToolResult, dropStaleReasoning, estimateTokens, insertSummary, isContextError, MAX_TOOL_RESULT_CHARS, needsSummary, recordSummary,
  requestMessages, standaloneSummaryRequest, summaryAllowed, summaryCut, trimHistory, TRIM_MIN_TOKENS,
} from './context';

const NOW = Date.UTC(2026, 10, 2, 12);
const problem: AgentMessage = { role: 'user', kind: 'problem', content: '当前题目信息\n题目：两数之和' };
const user = (content: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ role: 'user', content, ...extra });
const assistant = (content: string, endedAt?: number): AgentMessage => ({ role: 'assistant', content, ...(endedAt ? { trace: { model: 'm', totalMs: 1, endedAt, steps: [], tools: [] } } : {}) });
const call = (id: string): AgentMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'get_code', arguments: '{}' } }] });
const tool = (id: string, content: string): AgentMessage => ({ role: 'tool', tool_call_id: id, content });
/** 一轮：提问、读代码、回答 */
const turn = (n: number, codeChars: number, endedAt = NOW - 60_000): AgentMessage[] => [
  user(`问${n}`), call(`c${n}`), tool(`c${n}`, `代码${n}:${'x'.repeat(codeChars)}`), assistant(`答${n}`, endedAt),
];
const omittedIds = (messages: AgentMessage[]) => messages.filter((message) => message.omitted).map((message) => message.tool_call_id);

describe('requestMessages', () => {
  it('puts the stored memory before the question and a placeholder for trimmed results', () => {
    const sent = requestMessages([problem, user('问', { memoryText: '<memory>用 Go</memory>' }), call('a'), { ...tool('a', '很长的代码'), omitted: true }]);
    expect(sent[1]!.content).toBe('<memory>用 Go</memory>\n\n问');
    expect(sent[3]!.content).toContain('omitted');
  });
  it('sends only the problem, the latest summary and what comes after it', () => {
    const summary: AgentMessage = { role: 'user', kind: 'summary', content: '摘要' };
    expect(requestMessages([problem, user('旧'), assistant('旧答'), summary, user('新'), assistant('新答')]).map((message) => message.content))
      .toEqual([problem.content, '摘要', '新', '新答']);
  });
  it('does not touch the stored messages', () => {
    const stored = [problem, user('问', { memoryText: '记忆' })];
    requestMessages(stored);
    expect(stored[1]!.content).toBe('问');
  });
});

describe('cache-friendly history', () => {
  /** 每轮提问前裁一次（和插件一样），返回这一轮发出去的请求 */
  function conversation(turns: number, codeChars: number) {
    let stored: AgentMessage[] = [problem];
    const requests: AgentMessage[][] = [];
    for (let n = 1; n <= turns; n++) {
      stored = trimHistory([...stored, user(`问${n}`, n === 1 ? { memoryText: '<memory>用 Go</memory>' } : {})], NOW);
      requests.push(requestMessages(stored));
      stored = [...stored, call(`c${n}`), tool(`c${n}`, 'x'.repeat(codeChars)), assistant(`答${n}`, NOW - 60_000)];
    }
    return requests;
  }
  it('keeps every earlier request as an exact prefix until a trim happens', () => {
    const requests = conversation(6, 400);
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1]!;
      expect(requests[index]!.slice(0, previous.length)).toEqual(previous);
    }
  });
  it('breaks the prefix only on the turns where it trims, and then far less often than every turn', () => {
    const requests = conversation(30, 6000);
    let breaks = 0;
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1]!;
      if (JSON.stringify(requests[index]!.slice(0, previous.length)) !== JSON.stringify(previous)) breaks++;
    }
    expect(breaks).toBeGreaterThan(0);
    // 改之前每轮都断；现在每次裁剪至少要攒够 TRIM_MIN_TOKENS，这里每轮约 1500 token，最多隔一轮断一次
    expect(breaks).toBeLessThanOrEqual(Math.ceil((requests.length - 1) / 2));
  });
  it('keeps the memory of the first question in every later request', () => {
    const requests = conversation(4, 100);
    expect(requests.at(-1)![1]!.content).toContain('<memory>用 Go</memory>');
  });
});

describe('trimHistory', () => {
  it('leaves everything alone while the old results are small', () => {
    const history = [problem, ...turn(1, 2000), ...turn(2, 2000), user('问3')];
    expect(trimHistory(history, NOW)).toBe(history);
  });
  it('trims all old results at once when they add up, keeping the last two questions', () => {
    // 拉丁字符 4 个算 1 个 token
    const big = TRIM_MIN_TOKENS * 4;
    const history = [problem, ...turn(1, big), ...turn(2, 300), ...turn(3, big), user('问4')];
    const trimmed = trimHistory(history, NOW);
    expect(omittedIds(trimmed)).toEqual(['c1', 'c2']);
    expect(trimmed.at(-1)).toBe(history.at(-1));
    expect(history.some((message) => message.omitted)).toBe(false);
  });
  it('never changes a result once decided, and does not trim again for a little more', () => {
    const big = TRIM_MIN_TOKENS * 4;
    const first = trimHistory([problem, ...turn(1, big), ...turn(2, 300), user('问3')], NOW);
    expect(omittedIds(first)).toEqual(['c1']);
    const second = [...first, call('c3'), tool('c3', 'x'.repeat(300)), assistant('答3', NOW - 60_000), user('问4')];
    expect(trimHistory(second, NOW)).toBe(second);
  });
  it('trims even a little once the cache has gone cold', () => {
    const history = [problem, ...turn(1, 500, NOW - CACHE_COLD_MS - 1), ...turn(2, 500, NOW - CACHE_COLD_MS - 1), user('问3')];
    expect(omittedIds(trimHistory(history, NOW))).toEqual(['c1']);
    expect(trimHistory(history, NOW - CACHE_COLD_MS + 60_000)).toBe(history);
  });
  it('does not assume a cold cache when there is no run record', () => {
    const history = [problem, user('问1'), call('a'), tool('a', 'x'.repeat(500)), assistant('答1'), user('问2'), user('问3')];
    expect(trimHistory(history, NOW + 10 * CACHE_COLD_MS)).toBe(history);
  });
  it('skips results that are too short to matter and anything before a summary', () => {
    const summary: AgentMessage = { role: 'user', kind: 'summary', content: '摘要' };
    const history = [problem, ...turn(1, TRIM_MIN_TOKENS * 8), summary, ...turn(2, 50, NOW - CACHE_COLD_MS - 1), ...turn(3, 50), user('问4')];
    expect(trimHistory(history, NOW)).toBe(history);
  });
  it('keeps tool calls paired with results so the request stays valid', () => {
    const trimmed = requestMessages(trimHistory([problem, ...turn(1, TRIM_MIN_TOKENS * 8), ...turn(2, 10), user('问3')], NOW));
    expect(completedMessages(trimmed)).toHaveLength(trimmed.length);
  });
});

describe('capToolResult', () => {
  it('keeps short results and cuts long ones once, before they are ever sent', () => {
    expect(capToolResult('{"code":"x"}')).toBe('{"code":"x"}');
    const capped = JSON.parse(capToolResult('x'.repeat(MAX_TOOL_RESULT_CHARS + 10))) as { truncated: boolean; head: string };
    expect(capped.truncated).toBe(true);
    expect(capped.head).toHaveLength(MAX_TOOL_RESULT_CHARS);
  });
});

describe('summary', () => {
  const long = [problem, ...Array.from({ length: 12 }, (_, index) => [user(`问${index}`), assistant(`答${index}`)]).flat()];
  it('cuts before a user message, keeps recent messages and inserts a marker', () => {
    const cut = summaryCut(long);
    expect(long[cut]!.role).toBe('user');
    const result = insertSummary(long, cut, '这是摘要');
    expect(result).toHaveLength(long.length + 1);
    const sent = requestMessages(result);
    expect(sent[0]).toBe(problem);
    expect(sent[1]!.content).toContain('这是摘要');
    expect(sent.length).toBeLessThanOrEqual(10);
  });
  it('has nothing to cut when everything is recent or already summarized', () => {
    expect(summaryCut([problem, user('一条很长的消息')])).toBe(-1);
    const summarized = insertSummary(long, summaryCut(long), '摘要');
    expect(summaryCut(summarized.slice(0, summarized.findIndex((message) => message.kind === 'summary') + 3))).toBe(-1);
  });
  it('sends only the old conversation text in the standalone request, never the problem or tool output', () => {
    const history = [problem, user('问'), call('a'), tool('a', '工具输出'), assistant('答'), ...long.slice(1)];
    const request = standaloneSummaryRequest(history, summaryCut(history));
    const sent = request.messages[0]!.content!;
    expect(sent).toContain('[用户] 问');
    expect(sent).not.toContain('两数之和');
    expect(sent).not.toContain('工具输出');
    expect(request.system).toContain('用户说过的话');
  });
  it('folds the earlier summary into the standalone request', () => {
    const first = insertSummary(long, summaryCut(long), '第一次摘要');
    const more = [...first, ...Array.from({ length: 10 }, (_, index) => [user(`新问${index}`), assistant(`新答${index}`)]).flat()];
    const sent = standaloneSummaryRequest(more, summaryCut(more)).messages[0]!.content!;
    expect(sent).toContain('第一次摘要');
    expect(sent).not.toContain('[用户] 问0');
  });
  it('stops summarizing a conversation after three failures in a row', () => {
    const key = 'conversation-breaker';
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(summaryAllowed(key)).toBe(true);
      recordSummary(key, false);
    }
    expect(summaryAllowed(key)).toBe(false);
    recordSummary(key, true);
    expect(summaryAllowed(key)).toBe(true);
    expect(summaryAllowed('another-conversation')).toBe(true);
  });
});

describe('estimates and errors', () => {
  it('counts Chinese higher than latin text, and counts the stored memory', () => {
    expect(estimateTokens([user('二分查找')])).toBe(4);
    expect(estimateTokens([user('abcdefgh')])).toBe(2);
    expect(estimateTokens([user('问', { memoryText: '记忆' })])).toBe(3);
  });
  it('counts a stored reply once, by what is sent back, including its reasoning', () => {
    const blocks = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '答案' }];
    const claude: AgentMessage = { role: 'assistant', content: '答案', claudeContent: blocks };
    expect(estimateTokens([claude])).toBe(estimateTokens([{ role: 'assistant', content: JSON.stringify(blocks) }]));
    expect(estimateTokens([{ role: 'assistant', content: '答', reasoningContent: '想一想' }])).toBe(4);
  });
  it('asks for a summary only when what is sent is large', () => {
    expect(needsSummary([problem, user('短')])).toBe(false);
    expect(needsSummary([problem, user('字'.repeat(70_000))])).toBe(true);
    // 裁过的工具结果发出去只是占位，不算
    const trimmed = [problem, user('问'), call('a'), { ...tool('a', '字'.repeat(70_000)), omitted: true as const }, assistant('答'), user('问2')];
    expect(needsSummary(trimmed)).toBe(false);
  });
  it('recognises context errors from common services', () => {
    expect(isContextError(400, 'This model\'s maximum context length is 8192 tokens')).toBe(true);
    expect(isContextError(400, '{"error":"prompt is too long"}')).toBe(true);
    expect(isContextError(413, 'request too large')).toBe(true);
    expect(isContextError(400, 'invalid api key')).toBe(false);
    expect(isContextError(500, 'context length')).toBe(false);
  });
});

describe('modelRequest', () => {
  it('sends summaries and memory as plain user text, without internal fields', () => {
    const body = modelRequest({ baseUrl: 'x', model: 'm', apiKey: '' }, requestMessages([
      problem, { role: 'user', kind: 'summary', content: '摘要' }, user('问', { memoryText: '记忆', usedMemories: [{ id: 'a', text: 'b' }] }),
    ]), 'sys', []) as { messages: object[] };
    expect(body.messages[2]).toEqual({ role: 'user', content: '摘要' });
    expect(body.messages[3]).toEqual({ role: 'user', content: '记忆\n\n问' });
  });
});

describe('reasoning bound to the conversation', () => {
  // Claude 的思考块：前面的消息改了就作废，发回去新账号上直接报 400
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
  const claude = (text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ role: 'assistant', content: text, claudeContent: [thinking, { type: 'text', text }], ...extra });
  const claudeCall = (id: string): AgentMessage => ({ ...call(id), claudeContent: [thinking, { type: 'tool_use', id, name: 'get_code', input: {} }] });
  const blocksOf = (message: AgentMessage | undefined) => message?.claudeContent?.map((block) => block.type);

  it('drops the thinking after the edit and keeps everything before it', () => {
    const history = [problem, user('问1'), claude('答1'), user('问2'), claude('答2')];
    const result = dropStaleReasoning(history, 3);
    expect(result[2]).toBe(history[2]);
    expect(blocksOf(result[4])).toEqual(['text']);
    expect(dropStaleReasoning(history, 4)).toBe(history);
  });
  it('drops it when old tool results are trimmed, only after the first trimmed one', () => {
    const big = 'x'.repeat(TRIM_MIN_TOKENS * 8);
    const history = [problem, user('问1'), claudeCall('c1'), tool('c1', big), claude('答1', { trace: { model: 'm', totalMs: 1, endedAt: NOW - 60_000, steps: [], tools: [] } }),
      ...turn(2, 10), ...turn(3, 10), user('问4')];
    const trimmed = trimHistory(history, NOW);
    expect(omittedIds(trimmed)).toEqual(['c1']);
    expect(blocksOf(trimmed[2])).toEqual(['thinking', 'tool_use']);
    expect(blocksOf(trimmed[4])).toEqual(['text']);
    // 别家的推理内容不绑定对话，不动
    const deepseek = trimHistory(history.map((message) => (message.claudeContent ? { ...message, claudeContent: undefined, reasoningContent: '想' } : message)), NOW);
    expect(deepseek.filter((message) => message.reasoningContent).length).toBe(2);
  });
  it('drops it from the turns kept after a summary', () => {
    const history = [problem, user('问1'), claude('答1'), user('问2'), claude('答2')];
    const summarized = insertSummary(history, 3, '摘要');
    expect(summarized[3]?.kind).toBe('summary');
    expect(blocksOf(summarized[2])).toEqual(['thinking', 'text']);
    expect(blocksOf(summarized[5])).toEqual(['text']);
  });
});
