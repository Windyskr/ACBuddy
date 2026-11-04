import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentSettings } from './agent';
import { forcesTool, modelRequest, postModel, readModelStream, structuredReply, structuredRequest, usageOf } from './agent-protocol';
import { routedVendor } from './providers';

const encoder = new TextEncoder();
function sse(chunks: string[]) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (value: object, extra: object = {}) => data({ choices: [{ delta: value }], ...extra });
// 用哪种接口按地址判断，不认识的地址写到具体的接口
const CHAT = 'https://example.com/v1/chat/completions';
const RESPONSES = 'https://example.com/v1/responses';
async function read(response: Response, baseUrl: string) {
  const texts: string[] = [];
  let chunks = 0;
  const result = await readModelStream(response, { baseUrl, model: 'm', apiKey: '' }, performance.now(), { onText: (text) => texts.push(text), onChunk: () => { chunks++; } });
  return { result, texts, chunks };
}

describe('Chat Completions stream', () => {
  it('reports the text as it grows and keeps the usage from the last chunk', async () => {
    const { result, texts } = await read(sse([
      delta({ content: '你' }), delta({ content: '好' }),
      data({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } }), 'data: [DONE]\n\n',
    ]), CHAT);
    expect(texts).toEqual(['你', '你好']);
    expect(result.reply).toEqual({ role: 'assistant', content: '你好' });
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2, cachedTokens: 5 });
    expect(result.firstTokenMs).not.toBeNull();
  });
  it('joins tool call fragments, including several parallel calls', async () => {
    const { result } = await read(sse([
      delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'get_code', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'search_memory', arguments: '{"qu' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: 'ery":"go"}' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
      'data: [DONE]\n\n',
    ]), CHAT);
    expect(result.reply.content).toBeNull();
    expect(result.reply.tool_calls).toEqual([
      { id: 'a', type: 'function', function: { name: 'get_code', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'search_memory', arguments: '{"query":"go"}' } },
    ]);
  });
  it('handles lines split across network chunks and multi-byte characters split across bytes', async () => {
    const line = encoder.encode(delta({ content: '二分' }));
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(line.slice(0, 20));
        controller.enqueue(line.slice(20));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    expect((await read(response, 'chat-completions')).result.reply.content).toBe('二分');
  });
  it('skips comments and malformed lines, and surfaces an error event', async () => {
    const { result } = await read(sse([': keep-alive\n\n', 'data: not json\n\n', delta({ content: 'ok' }), 'data: [DONE]\n\n']), CHAT);
    expect(result.reply.content).toBe('ok');
    await expect(read(sse([data({ error: { message: '额度不足' } })]), CHAT)).rejects.toThrow('额度不足');
  });
  it('counts every chunk for the idle timeout', async () => {
    const { chunks } = await read(sse([delta({ content: 'a' }), delta({ content: 'b' }), 'data: [DONE]\n\n']), CHAT);
    expect(chunks).toBe(3);
  });
});

describe('Responses stream', () => {
  const completed = (output: unknown[], usage: object = { input_tokens: 9, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }) =>
    data({ type: 'response.completed', response: { status: 'completed', output, usage } });
  it('streams text and takes the final message from the completed event', async () => {
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }];
    const { result, texts } = await read(sse([
      data({ type: 'response.output_text.delta', delta: '你' }), data({ type: 'response.output_text.delta', delta: '好' }), completed(output),
    ]), RESPONSES);
    expect(texts).toEqual(['你', '你好']);
    expect(result.reply.content).toBe('你好');
    expect(result.reply.responsesOutput).toEqual(output);
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4, cachedTokens: 3 });
  });
  it('returns tool calls from the completed event', async () => {
    const { result } = await read(sse([
      data({ type: 'response.function_call_arguments.delta', delta: '{}' }),
      completed([{ type: 'function_call', call_id: 'c', name: 'get_code', arguments: '{}' }]),
    ]), RESPONSES);
    expect(result.reply.tool_calls?.[0]?.function.name).toBe('get_code');
    expect(result.firstTokenMs).not.toBeNull();
  });
  it('reports incomplete and failed responses', async () => {
    await expect(read(sse([data({ type: 'response.incomplete', response: { status: 'incomplete', output: [] } })]), RESPONSES)).rejects.toThrow('生成未完成');
    await expect(read(sse([data({ type: 'error', message: '服务出错' })]), RESPONSES)).rejects.toThrow('服务出错');
  });
  it('treats a stream that ends early as an error', async () => {
    await expect(read(sse([data({ type: 'response.output_text.delta', delta: '你' })]), RESPONSES)).rejects.toThrow('响应中断');
  });
});

describe('services that ignore stream: true', () => {
  it('parses a plain JSON response', async () => {
    const body = { choices: [{ message: { role: 'assistant', content: '好' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
    const { result, texts } = await read(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }), CHAT);
    expect(result.reply.content).toBe('好');
    expect(result.usage.inputTokens).toBe(3);
    expect(result.firstTokenMs).toBeNull();
    expect(texts).toEqual([]);
  });
});

describe('usageOf', () => {
  it('is all zeros when the service reports nothing', () => {
    expect(usageOf({})).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(usageOf(null)).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });
});

describe('provider rules', () => {
  const problem: AgentMessage = { role: 'user', kind: 'problem', content: '题目' };
  const toolsList = [{ type: 'function', function: { name: 'get_code', description: '读代码', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }];
  const history: AgentMessage[] = [
    problem, { role: 'user', content: '问' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_code', arguments: '{}' } }], reasoningContent: '先读代码', reasoningDetails: [{ type: 'reasoning.text', text: '先读代码', signature: 's', index: 0 }] },
    { role: 'tool', tool_call_id: 'c1', content: '{}' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '再问' },
  ];
  const settings = (baseUrl: string, model: string): AgentSettings => ({ baseUrl, model, apiKey: 'k' });
  const deepseek = settings('https://api.deepseek.com', 'deepseek-flash');
  const routed = (model: string) => settings('https://openrouter.ai/api/v1', model);
  type Chat = { messages: Record<string, unknown>[]; [key: string]: unknown };
  const chat = (value: AgentSettings) => modelRequest(value, history, '系统', toolsList, { stream: true, conversationId: 'conv' }) as Chat;

  it('sends DeepSeek its reasoning back on every assistant turn, empty when there was none', () => {
    const body = chat(deepseek);
    expect(body.messages.filter((message) => message.role === 'assistant').map((message) => message.reasoning_content)).toEqual(['先读代码', '']);
    expect(body.messages.some((message) => 'reasoning_details' in message)).toBe(false);
    expect(body.session_id).toBeUndefined();
  });
  it('does not send reasoning fields to services that do not know them', () => {
    const body = chat(settings('https://api.example.com/v1', 'm'));
    expect(body.messages.some((message) => 'reasoning_content' in message || 'reasoning_details' in message || 'reasoning' in message)).toBe(false);
  });
  it('sends OpenRouter its reasoning details, pins the conversation to one provider and marks Claude for caching', () => {
    const claude = chat(routed('anthropic/claude-sonnet-5.5'));
    expect(claude.messages[3]!.reasoning_details).toEqual(history[2]!.reasoningDetails);
    expect(claude.session_id).toBe('acb-conv');
    expect(claude.cache_control).toEqual({ type: 'ephemeral' });
    expect(claude.reasoning).toEqual({ effort: 'medium' });
    expect(claude.messages[1]!.content).toEqual([{ type: 'text', text: '题目', cache_control: { type: 'ephemeral' } }]);
    expect(claude.messages[2]!.content).toBe('问');
    const gpt = chat(routed('openai/gpt-5.6-luna'));
    expect(gpt.cache_control).toBeUndefined();
    expect(gpt.reasoning).toBeUndefined();
    expect(gpt.messages[1]!.content).toBe('题目');
    // 只有推理文字、没有 reasoning_details 时发文字
    const plain = modelRequest(routed('deepseek/deepseek-v4.1-flash'), [{ role: 'assistant', content: '答', reasoningContent: '想' }], '', []) as Chat;
    expect(plain.messages[0]!.reasoning).toBe('想');
  });
  it('recognises OpenRouter aliases by the vendor after the ~', () => {
    expect(routedVendor('~anthropic/claude-sonnet-latest')).toBe('anthropic');
    expect(routedVendor('~openai/gpt-luna-latest')).toBe('openai');
    expect(routedVendor('google/gemini')).toBeNull();
    const alias = chat(routed('~anthropic/claude-sonnet-latest'));
    expect(alias.cache_control).toEqual({ type: 'ephemeral' });
    expect(alias.reasoning).toEqual({ effort: 'medium' });
  });
  it('sends reasoning back to the third-party service that produced it, and only to it', () => {
    const other = (baseUrl: string) => modelRequest(settings(baseUrl, 'deepseek-ai/DeepSeek-V4.1-Flash'), [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_code', arguments: '{}' } }], reasoningContent: '想', reasoningHost: 'api.siliconflow.cn' },
      { role: 'tool', tool_call_id: 'c', content: '{}' },
    ], '', toolsList) as Chat;
    expect(other('https://api.siliconflow.cn/v1').messages[0]!.reasoning_content).toBe('想');
    expect(other('https://ark.example.com/v3').messages[0]).not.toHaveProperty('reasoning_content');
  });
  it('maps the effort from settings to each service, and leaves the default alone', () => {
    const effort = (value: AgentSettings) => modelRequest(value, history, '系统', toolsList, { effort: 'high' });
    expect(effort(settings('https://api.openai.com/v1', 'gpt-5.6-luna')).reasoning).toEqual({ effort: 'high' });
    expect(effort(deepseek).reasoning_effort).toBe('high');
    expect(effort(routed('anthropic/claude-sonnet-5.5')).reasoning).toEqual({ effort: 'high' });
    expect(effort(routed('openai/gpt-5.6-terra')).reasoning).toEqual({ effort: 'high' });
    expect(effort(routed('openai/gpt-5.6-terra')).reasoning_effort).toBeUndefined();
    const plain = modelRequest(settings('https://api.openai.com/v1', 'gpt-5.6-luna'), history, '系统', toolsList);
    expect(plain.reasoning).toBeUndefined();
    expect(modelRequest(deepseek, history, '系统', toolsList).reasoning_effort).toBeUndefined();
  });
  it('gives OpenAI a cache key per conversation', () => {
    const body = modelRequest(settings('https://api.openai.com/v1', 'gpt-5.6-luna'), history, '系统', toolsList, { conversationId: 'conv' });
    expect(body.prompt_cache_key).toBe('acb-conv');
    expect(modelRequest(settings('https://api.example.com/v1/responses', 'm'), history, '系统', toolsList, { conversationId: 'conv' }).prompt_cache_key).toBeUndefined();
  });
  it('sends OpenRouter attribution headers', async () => {
    const seen: Record<string, string>[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response('{}'); }) as typeof fetch;
    try {
      await postModel(routed('openai/gpt-5.6-luna'), {}, new AbortController().signal);
      await postModel(deepseek, {}, new AbortController().signal);
    } finally { globalThis.fetch = original; }
    expect(seen[0]).toMatchObject({ Authorization: 'Bearer k', 'X-OpenRouter-Title': 'ACBuddy' });
    expect(seen[1]).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer k' });
  });
});

describe('structured requests for memory', () => {
  const tool = { name: 'save_memories', description: '保存', parameters: { type: 'object', properties: { memories: { type: 'array', items: { type: 'string' } } }, required: ['memories'], additionalProperties: false } };
  const request = { system: '整理', messages: [{ role: 'user' as const, content: '对话' }], tool };
  const build = (baseUrl: string, model: string) => structuredRequest({ baseUrl, model, apiKey: '' }, request);

  it('forces the tool where the service allows it', () => {
    expect(build('https://api.openai.com/v1', 'gpt-5.6-terra').tool_choice).toEqual({ type: 'function', name: 'save_memories' });
    expect(build('https://api.example.com/v1', 'm').tool_choice).toEqual({ type: 'function', function: { name: 'save_memories' } });
  });
  it('turns DeepSeek thinking off, since thinking mode refuses a forced tool', () => {
    const body = build('https://api.deepseek.com', 'deepseek-flash');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'save_memories' } });
    expect(build('https://openrouter.ai/api/v1', 'deepseek/deepseek-v4.1-flash').reasoning).toEqual({ enabled: false });
  });
  it('asks Claude on OpenRouter for structured output instead of a forced tool', () => {
    const body = build('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5.5');
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'save_memories', strict: true, schema: tool.parameters } });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.cache_control).toBeUndefined();
    expect(JSON.stringify(body.messages)).not.toContain('cache_control');
  });
  it('falls back to asking for the tool in the prompt, keeping the schema', () => {
    const forced = build('https://api.example.com/v1', 'm');
    const relaxed = structuredRequest({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: '' }, request, { force: false });
    expect(forcesTool(forced)).toBe(true);
    expect(forcesTool(relaxed)).toBe(false);
    expect(relaxed.tool_choice).toBe('auto');
    expect((relaxed.tools as object[]).length).toBe(1);
    expect((relaxed.messages as { content: string }[])[0]!.content).toBe('整理\n\n调用 save_memories 工具给出结果，不要直接回复。');
    const responses = structuredRequest({ baseUrl: 'https://api.example.com/v1/responses', model: 'm', apiKey: '' }, request, { force: false });
    expect(responses.tool_choice).toBe('auto');
    expect(responses.instructions).toContain('调用 save_memories 工具');
    // 结构化输出、Claude 都没有强制调用，不会再试
    expect(forcesTool(build('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5.5'))).toBe(false);
  });
  it('never uses the effort from settings for memory', () => {
    for (const [baseUrl, model] of [['https://api.deepseek.com', 'deepseek-flash'], ['https://api.openai.com/v1', 'gpt-5.6-luna'],
      ['https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5.5']] as const) {
      const body = structuredRequest({ baseUrl, model, apiKey: '', effort: 'high' }, request);
      expect(JSON.stringify(body)).not.toContain('"high"');
    }
  });
  it('turns off caching for one-off requests on GPT-5.6 and later only', () => {
    expect(build('https://api.openai.com/v1', 'gpt-5.6-luna').prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(build('https://openrouter.ai/api/v1', 'openai/gpt-5.6-terra').prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(build('https://api.openai.com/v1', 'gpt-5.5').prompt_cache_options).toBeUndefined();
    // 官方文档只写了 Responses 支持
    expect(build('https://api.openai.com/v1/chat/completions', 'gpt-5.6-luna').prompt_cache_options).toBeUndefined();
    expect(build('https://api.openai.com/v1', 'gpt-5.6-luna').prompt_cache_key).toBeUndefined();
  });
  it('reads tool arguments or a JSON answer, and refuses plain text', () => {
    const settings: AgentSettings = { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', apiKey: '' };
    expect(structuredReply(settings, { content: [{ type: 'text', text: '{"memories":[]}' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }, request))
      .toEqual({ text: '', toolArguments: '{"memories":[]}', usage: { inputTokens: 3, outputTokens: 2, cachedTokens: 0, cacheWriteTokens: 0 } });
    expect(structuredReply(settings, { content: [{ type: 'tool_use', id: 't', name: 'save_memories', input: { memories: ['a'] } }], stop_reason: 'tool_use' }, request).toolArguments).toBe('{"memories":["a"]}');
    expect(() => structuredReply(settings, { content: [{ type: 'text', text: '好的' }], stop_reason: 'end_turn' }, request)).toThrow('结构化结果');
  });
});

describe('reasoning in Chat Completions replies', () => {
  it('keeps DeepSeek reasoning and OpenRouter reasoning details from a stream', async () => {
    const { result } = await read(sse([
      delta({ reasoning_content: '先' }), delta({ reasoning_content: '读代码' }),
      delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'get_code', arguments: '{}' } }] }),
      data({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } }), 'data: [DONE]\n\n',
    ]), 'https://api.deepseek.com');
    expect(result.reply.reasoningContent).toBe('先读代码');
    expect(result.reply.reasoningHost).toBe('api.deepseek.com');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5, cachedTokens: 64 });
    const routed = await read(sse([
      delta({ reasoning: '想', reasoning_details: [{ type: 'reasoning.text', text: '想', index: 0, format: 'anthropic-claude-v1' }] }),
      delta({ reasoning_details: [{ type: 'reasoning.text', text: '一想', index: 0 }] }),
      delta({ reasoning_details: [{ type: 'reasoning.text', signature: 'sig', index: 0 }] }),
      delta({ content: '答' }),
      data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 6 } } }), 'data: [DONE]\n\n',
    ]), 'https://openrouter.ai/api/v1');
    expect(routed.result.reply.reasoningDetails).toEqual([{ type: 'reasoning.text', text: '想一想', index: 0, format: 'anthropic-claude-v1', signature: 'sig' }]);
    expect(routed.result.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedTokens: 4, cacheWriteTokens: 6 });
  });
});
