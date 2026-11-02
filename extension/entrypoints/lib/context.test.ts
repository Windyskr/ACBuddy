import { describe, expect, it } from 'vitest';
import { ScriptedLlm } from '../../eval/llm';
import type { AgentMessage } from './agent';
import { completedMessages } from './agent';
import { estimateTokens, isContextError, needsSummary, prepareContext, summarizeHistory } from './context';
import { modelRequest } from './agent-protocol';

const problem: AgentMessage = { role: 'user', kind: 'problem', content: '当前题目信息\n题目：两数之和' };
const user = (content: string): AgentMessage => ({ role: 'user', content });
const assistant = (content: string): AgentMessage => ({ role: 'assistant', content });
const call = (id: string): AgentMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'get_code', arguments: '{}' } }] });
const tool = (id: string, content: string): AgentMessage => ({ role: 'tool', tool_call_id: id, content });

describe('prepareContext', () => {
  const history = [problem, user('问1'), call('a'), tool('a', '代码版本1'), assistant('答1'), user('问2'), call('b'), tool('b', '代码版本2'), assistant('答2'), user('问3'), call('c'), tool('c', '代码版本3')];
  it('replaces old tool results and keeps the recent ones', () => {
    const contents = prepareContext(history).filter((message) => message.role === 'tool').map((message) => message.content);
    expect(contents[0]).toContain('omitted');
    expect(contents[1]).toBe('代码版本2');
    expect(contents[2]).toBe('代码版本3');
  });
  it('keeps every tool call paired with a result so the request stays valid', () => {
    const prepared = prepareContext(history);
    for (const message of prepared) {
      for (const toolCall of message.tool_calls ?? []) expect(prepared.some((item) => item.tool_call_id === toolCall.id)).toBe(true);
    }
    expect(completedMessages(prepared)).toHaveLength(prepared.length);
  });
  it('does not touch the stored messages', () => {
    prepareContext(history);
    expect(history[3]!.content).toBe('代码版本1');
  });
  it('sends only the problem, the latest summary and what comes after it', () => {
    const summary: AgentMessage = { role: 'user', kind: 'summary', content: '摘要' };
    const prepared = prepareContext([problem, user('旧'), assistant('旧答'), summary, user('新'), assistant('新答')]);
    expect(prepared.map((message) => message.content)).toEqual([problem.content, '摘要', '新', '新答']);
  });
});

describe('summarizeHistory', () => {
  const long = [problem, ...Array.from({ length: 12 }, (_, index) => [user(`问${index}`), assistant(`答${index}`)]).flat()];
  it('inserts a summary before a user message and keeps recent messages', async () => {
    const llm = new ScriptedLlm(['这是摘要']);
    const result = await summarizeHistory(long, llm);
    const index = result!.findIndex((message) => message.kind === 'summary');
    expect(result![index]!.content).toContain('这是摘要');
    expect(result![index + 1]!.role).toBe('user');
    expect(result).toHaveLength(long.length + 1);
    const prepared = prepareContext(result!);
    expect(prepared[0]).toBe(problem);
    expect(prepared[1]!.kind).toBe('summary');
    expect(prepared.length).toBeLessThanOrEqual(10);
  });
  it('never sends the problem statement or tool output to the summarizer', async () => {
    const llm = new ScriptedLlm(['摘要']);
    await summarizeHistory([problem, user('问'), call('a'), tool('a', '工具输出'), assistant('答'), ...long.slice(1)], llm);
    const sent = llm.requests[0]!.messages[0]!.content;
    expect(sent).toContain('[用户] 问');
    expect(sent).not.toContain('两数之和');
    expect(sent).not.toContain('工具输出');
  });
  it('folds the earlier summary into the next one', async () => {
    const first = (await summarizeHistory(long, new ScriptedLlm(['第一次摘要'])))!;
    const more = [...first, ...Array.from({ length: 10 }, (_, index) => [user(`新问${index}`), assistant(`新答${index}`)]).flat()];
    const llm = new ScriptedLlm(['第二次摘要']);
    const second = (await summarizeHistory(more, llm))!;
    expect(llm.requests[0]!.messages[0]!.content).toContain('第一次摘要');
    expect(llm.requests[0]!.messages[0]!.content).not.toContain('[用户] 问0');
    expect(prepareContext(second).filter((message) => message.kind === 'summary').map((message) => message.content)).toEqual([expect.stringContaining('第二次摘要')]);
  });
  it('returns null when there is nothing to cut or the model fails', async () => {
    expect(await summarizeHistory([problem, user('一条很长的消息')], new ScriptedLlm(['x']))).toBeNull();
    expect(await summarizeHistory(long, new ScriptedLlm(() => { throw new Error('失败'); }))).toBeNull();
    expect(await summarizeHistory(long, new ScriptedLlm(['  ']))).toBeNull();
  });
});

describe('estimates and errors', () => {
  it('counts Chinese higher than latin text per character', () => {
    expect(estimateTokens([user('二分查找')])).toBe(4 + Math.ceil(2 / 4));
    expect(estimateTokens([user('abcdefgh')])).toBe(3);
  });
  it('asks for a summary only when the prepared context is large', () => {
    expect(needsSummary([problem, user('短')])).toBe(false);
    expect(needsSummary([problem, user('字'.repeat(70_000))])).toBe(true);
    // 旧工具结果不算：先裁掉它们就够了
    const tools = [problem, user('问'), call('a'), tool('a', '字'.repeat(70_000)), assistant('答'), user('问2'), assistant('答2'), user('问3')];
    expect(needsSummary(tools)).toBe(false);
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
  it('sends summaries as plain user text, without internal fields', () => {
    const body = modelRequest({ baseUrl: 'x', model: 'm', apiKey: '', apiType: 'chat-completions' }, [{ role: 'user', kind: 'summary', content: '摘要', usedMemories: [{ id: 'a', text: 'b' }] }], 'sys', []) as { messages: object[] };
    expect(body.messages[1]).toEqual({ role: 'user', content: '摘要' });
  });
});
