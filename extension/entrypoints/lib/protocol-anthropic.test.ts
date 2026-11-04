import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentSettings } from './agent';
import { endpointFor } from './agent-protocol';
import { claudeHeaders, claudeReply, claudeRequest, claudeStructuredRequest, claudeUsage, readClaudeStream } from './protocol-anthropic';
import { ContextTooLongError, RefusalError } from './protocol-common';

const official: AgentSettings = { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', apiKey: 'k' };
const proxy: AgentSettings = { ...official, baseUrl: 'https://relay.example.com/v1/messages' };
const problem: AgentMessage = { role: 'user', kind: 'problem', content: '题目：两数之和' };
const tools = [{ type: 'function', function: { name: 'get_code', description: '读代码', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }];
const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };

type Body = { messages: { role: string; content: Record<string, unknown>[] }[]; [key: string]: unknown };
const request = (settings: AgentSettings, messages: AgentMessage[]) => claudeRequest(settings, messages, '系统提示', tools, true) as unknown as Body;

describe('Claude request', () => {
  const history: AgentMessage[] = [
    problem, { role: 'user', content: '帮我看看' },
    { role: 'assistant', content: '我先读代码', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_code', arguments: '{}' } }],
      claudeContent: [thinking, { type: 'text', text: '我先读代码' }, { type: 'tool_use', id: 'toolu_1', name: 'get_code', input: {} }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: '{"code":"x"}' },
  ];

  it('merges the problem with the question and puts tool results in one user turn', () => {
    const body = request(official, history);
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[0]!.content.map((block) => block.text)).toEqual(['题目：两数之和', '帮我看看']);
    expect(body.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"code":"x"}' });
    expect(body.system).toEqual([{ type: 'text', text: '系统提示' }]);
    expect(body.tools).toEqual([{ name: 'get_code', description: '读代码', input_schema: tools[0]!.function.parameters }]);
  });
  it('sends the stored reply back unchanged, with its signed thinking', () => {
    const body = request(official, history);
    expect(body.messages[1]!.content).toEqual(history[2]!.claudeContent);
  });
  it('marks the problem and the end of the request for caching, without touching the stored blocks', () => {
    const body = request(official, history);
    expect(body.messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.messages[0]!.content[1]!.cache_control).toBeUndefined();
    expect(body.messages[2]!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(history[3]).not.toHaveProperty('cache_control');
    // 只有一条消息时两处标记落在同一条上
    const first = request(official, [problem, { role: 'user', content: '问' }]);
    expect(first.messages[0]!.content.map((block) => block.cache_control)).toEqual([{ type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '1h' }]);
    // 兼容服务用默认的 5 分钟
    expect(request(proxy, history).messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });
  it('keeps every earlier request as an exact prefix of the next one', () => {
    const strip = (body: Body) => JSON.stringify(body.messages.map((message) => ({ ...message, content: message.content.map(({ cache_control: _, ...block }) => block) })));
    const before = strip(request(official, history));
    const after = strip(request(official, [...history, { role: 'assistant', content: '找到了', claudeContent: [{ type: 'text', text: '找到了' }] }, { role: 'user', content: '谢谢' }]));
    expect(after.startsWith(before.slice(0, -2))).toBe(true);
  });
  it('turns on adaptive thinking with drop_block, medium effort and the refusal fallback on the official API only', () => {
    const body = request(official, history);
    expect(body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.fallbacks).toBe('default');
    expect(body.max_tokens).toBe(16_000);
    const relayed = request(proxy, history);
    expect(relayed.thinking).toBeUndefined();
    expect(relayed.fallbacks).toBeUndefined();
    expect(relayed.output_config).toEqual({ effort: 'medium' });
    // 设置里选了思考强度就用它
    expect((claudeRequest(official, history, '系统提示', tools, true, 'high') as unknown as Body).output_config).toEqual({ effort: 'high' });
    expect((claudeRequest(proxy, history, '系统提示', tools, true, 'low') as unknown as Body).output_config).toEqual({ effort: 'low' });
    // 4.6 之前的模型不认自适应思考和 effort
    const old = request({ ...official, model: 'claude-haiku-4-5' }, history);
    expect(old.thinking).toBeUndefined();
    expect(old.output_config).toBeUndefined();
    expect(old.fallbacks).toBeUndefined();
    expect(request({ ...official, model: 'claude-opus-4-6' }, history).thinking).toBeDefined();
  });
  it('rebuilds replies that came from another service, with ids Claude accepts', () => {
    const body = request(official, [problem, { role: 'user', content: '问' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call:1', type: 'function', function: { name: 'get_code', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'call:1', content: '' }]);
    expect(body.messages[1]!.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_code', input: { a: 1 } }]);
    expect(body.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: '{}' });
  });
  it('sends the key, version and beta headers the body needs', () => {
    const body = claudeRequest(official, history, 's', tools, false);
    expect(claudeHeaders(official, body)).toEqual({
      'Content-Type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': 'thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01',
    });
    const relayed = claudeHeaders(proxy, claudeRequest(proxy, history, 's', tools, false));
    expect(relayed['anthropic-version']).toBe('2023-06-01');
    expect(relayed['anthropic-beta']).toBeUndefined();
  });
  it('finds the messages endpoint with or without /v1 in the base address', () => {
    expect(endpointFor('https://api.anthropic.com/v1', 'anthropic').href).toBe('https://api.anthropic.com/v1/messages');
    expect(endpointFor('https://api.anthropic.com', 'anthropic').href).toBe('https://api.anthropic.com/v1/messages');
    expect(endpointFor('https://api.deepseek.com/anthropic', 'anthropic').href).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(endpointFor('https://api.anthropic.com/v1/messages', 'anthropic').href).toBe('https://api.anthropic.com/v1/messages');
    expect(endpointFor('https://openrouter.ai/api/v1', 'anthropic').href).toBe('https://openrouter.ai/api/v1/messages');
  });
});

describe('Claude structured request', () => {
  const tool = { name: 'save', description: '保存', parameters: {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: { items: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['target', 'score'], properties: {
      target: { type: ['string', 'null'], description: '编号' }, score: { type: 'integer', minimum: 1, maximum: 5 },
    } } } },
  } };
  const messages: AgentMessage[] = [{ role: 'user', content: '对话' }];

  it('uses structured output on the official API, with a schema Claude accepts and no cache marks', () => {
    const body = claudeStructuredRequest(official, { system: '整理', messages, tool }) as Body;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['target', 'score'], properties: {
        target: { description: '编号', anyOf: [{ type: 'string' }, { type: 'null' }] }, score: { type: 'integer' },
      } } } },
    } } });
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });
  it('asks for the tool in the prompt on other services, without forcing it', () => {
    const body = claudeStructuredRequest(proxy, { system: '整理', messages, tool }) as Body;
    expect((body.tools as { name: string }[])[0]!.name).toBe('save');
    expect(body.tool_choice).toBeUndefined();
    expect((body.system as { text: string }[])[0]!.text).toContain('调用 save 工具');
  });
});

describe('Claude reply', () => {
  it('reads text, tool calls and keeps the blocks to send back', () => {
    const content = [thinking, { type: 'text', text: '看看代码' }, { type: 'tool_use', id: 'toolu_2', name: 'get_code', input: { a: 1 } }];
    const reply = claudeReply({ content, stop_reason: 'tool_use' });
    expect(reply).toEqual({
      role: 'assistant', content: '看看代码', claudeContent: content,
      tool_calls: [{ id: 'toolu_2', type: 'function', function: { name: 'get_code', arguments: '{"a":1}' } }],
    });
  });
  it('turns refusals, cut-off output and a full context window into errors', () => {
    expect(() => claudeReply({ content: [{ type: 'text', text: '半截' }], stop_reason: 'refusal' })).toThrow(RefusalError);
    expect(() => claudeReply({ content: [{ type: 'text', text: '半' }], stop_reason: 'max_tokens' })).toThrow('生成未完成');
    expect(() => claudeReply({ content: [], stop_reason: 'model_context_window_exceeded' })).toThrow(ContextTooLongError);
    expect(() => claudeReply({ type: 'error' })).toThrow('Anthropic Messages');
  });
  it('after a fallback keeps only the text from before it and continues the sentence', () => {
    const content = [
      thinking, { type: 'text', text: '这道题可以' }, { type: 'tool_use', id: 'toolu_x', name: 'get_code', input: {} },
      { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
      { type: 'text', text: '用双指针。' },
    ];
    const reply = claudeReply({ content, stop_reason: 'end_turn' });
    expect(reply.content).toBe('这道题可以用双指针。');
    expect(reply.tool_calls).toBeUndefined();
    expect(reply.claudeContent).toEqual([{ type: 'text', text: '这道题可以' }, { type: 'text', text: '用双指针。' }]);
  });
  it('separates text blocks with a blank line otherwise', () => {
    expect(claudeReply({ content: [{ type: 'text', text: '第一段' }, thinking, { type: 'text', text: '第二段' }], stop_reason: 'end_turn' }).content).toBe('第一段\n\n第二段');
  });
  it('adds cached and cache-written tokens to the input', () => {
    expect(claudeUsage({ input_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 50, output_tokens: 7 }))
      .toEqual({ inputTokens: 360, outputTokens: 7, cachedTokens: 300, cacheWriteTokens: 50 });
    expect(claudeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });
  });
});

describe('Claude stream', () => {
  const encoder = new TextEncoder();
  const sse = (events: object[], end = true) => new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`));
      if (end) controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const read = async (response: Response) => {
    const texts: string[] = [];
    let chunks = 0;
    const result = await readClaudeStream(response, performance.now(), { onText: (text) => texts.push(text), onChunk: () => { chunks++; } });
    return { result, texts, chunks };
  };

  it('rebuilds thinking, text and tool calls from the events', async () => {
    const { result, texts } = await read(sse([
      { type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 1 } } },
      { type: 'ping' },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '先' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '读代码' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_3', name: 'highlight_errors', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"ranges":[{"startLine":1,' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"endLine":2,"message":"越界"}]}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } },
    ]));
    expect(texts).toEqual(['先', '先读代码']);
    expect(result.reply.content).toBe('先读代码');
    expect(result.reply.claudeContent).toEqual([
      { type: 'thinking', thinking: '', signature: 'abc' },
      { type: 'text', text: '先读代码' },
      { type: 'tool_use', id: 'toolu_3', name: 'highlight_errors', input: { ranges: [{ startLine: 1, endLine: 2, message: '越界' }] } },
    ]);
    expect(result.reply.tool_calls?.[0]?.function).toEqual({ name: 'highlight_errors', arguments: '{"ranges":[{"startLine":1,"endLine":2,"message":"越界"}]}' });
    expect(result.usage).toEqual({ inputTokens: 945, outputTokens: 60, cachedTokens: 900, cacheWriteTokens: 40 });
    expect(result.firstTokenMs).not.toBeNull();
  });
  it('counts every event for the idle timeout, pings included', async () => {
    const { chunks } = await read(sse([{ type: 'ping' }, { type: 'ping' }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '好' } }]));
    expect(chunks).toBe(5);
  });
  it('surfaces errors, refusals and streams that stop early', async () => {
    await expect(read(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }], false))).rejects.toThrow('Overloaded');
    await expect(read(sse([{ type: 'message_delta', delta: { stop_reason: 'refusal' } }]))).rejects.toThrow('拒绝');
    await expect(read(sse([{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], false))).rejects.toThrow('响应中断');
  });
});
