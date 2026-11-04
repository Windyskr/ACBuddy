// 冒烟测试的离线版：把四家服务换成模拟的，模拟服务按各家文档的规则检查请求，违反就回 400。
// 真实接口要密钥才能测（npx tsx eval/run.ts providers），这里保证同样的三轮对话在规则上走得通
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDERS, routedVendor, type Vendor } from '../../entrypoints/lib/providers';
import { runProvider, runSettings } from './providers';

type Json = Record<string, any>;
const encoder = new TextEncoder();
const sse = (events: object[], done = false) => new Response(new ReadableStream({
  start(controller) {
    for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    if (done) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  },
}), { headers: { 'Content-Type': 'text/event-stream' } });
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
class Rejected extends Error {}
const reject = (message: string): never => { throw new Rejected(message); };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const memoryJson = JSON.stringify({ memories: [{ type: 'semantic', text: '用户主要用 Go 写题', quote: '我主要用 Go 写题', concepts: [], importance: 4, scope: 'persistent', problem_specific: false }] });
/** 去掉缓存标记再比较：移动标记不算改历史 */
const canonical = (value: unknown): string => JSON.stringify(value, (key, item) => (key === 'cache_control' ? undefined : item));

class MockServices {
  requests: { host: string; body: Json; headers: Record<string, string> }[] = [];
  errors: string[] = [];
  /** Claude 的思考块：签名 → 产生时的开头和前一个思考块 */
  private signatures = new Map<string, { prefix: string; previous: string | null }>();
  private serial = 0;
  dropped = 0;

  fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body)) as Json;
    const headers = init.headers as Record<string, string>;
    this.requests.push({ host: url.hostname, body, headers });
    try {
      if (url.hostname === 'api.anthropic.com') return this.anthropic(url, body, headers);
      if (url.hostname === 'api.deepseek.com') return this.deepseek(url, body, headers);
      // 第三方托管的 DeepSeek：一直在思考模式，不认 DeepSeek 关思考的参数
      if (url.hostname === 'api.siliconflow.cn') return this.deepseek(url, body, headers, true);
      if (url.hostname === 'api.openai.com') return this.openai(url, body, headers);
      if (url.hostname === 'openrouter.ai') return this.openrouter(url, body, headers);
      return reject(`unexpected host ${url.hostname}`);
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      this.errors.push(error.message);
      return json({ error: { message: error.message } }, 400);
    }
  };

  /** 和上一次请求相同的开头算命中缓存（每 4 个字符算 1 个 token） */
  private cached(host: string, text: string) {
    let best = 0;
    for (const previous of this.requests.slice(0, -1).filter((item) => item.host === host)) {
      const other = previous.body.__text as string | undefined;
      if (!other) continue;
      let length = 0;
      while (length < other.length && other[length] === text[length]) length++;
      best = Math.max(best, length);
    }
    this.requests.at(-1)!.body.__text = text;
    return Math.floor(best / 4);
  }

  /** 剧本：用户要看代码时先调 get_code，拿到结果后回答；其他时候直接回答 */
  private wantsTool(lastUserText: string, afterTool: boolean) {
    return !afterTool && lastUserText.includes('帮我看看');
  }

  private anthropic(url: URL, body: Json, headers: Record<string, string>) {
    if (url.pathname !== '/v1/messages') reject(`wrong path ${url.pathname}`);
    if (!headers['x-api-key'] || headers['anthropic-version'] !== '2026-10-21' || headers['anthropic-dangerous-direct-browser-access'] !== 'true') reject('missing Anthropic headers');
    if (!body.max_tokens) reject('max_tokens: Field required');
    for (const field of ['temperature', 'top_p', 'top_k']) if (field in body) reject(`${field} is not supported on 2026-10-21`);
    if (body.tool_choice && ['any', 'tool'].includes(body.tool_choice.type)) reject('tool_choice: type "tool" and "any" are not supported for this model.');
    if (body.thinking?.type === 'disabled') reject('"thinking.type.disabled" is not supported for this model.');
    if (body.thinking?.block_binding && !headers['anthropic-beta']?.includes('thinking-binding-controls-2026-08-01')) reject('block_binding: Extra inputs are not permitted');
    if (body.fallbacks && !headers['anthropic-beta']?.includes('server-side-fallback-2026-07-01')) reject('fallbacks: Extra inputs are not permitted');
    if (body.output_config?.effort && !EFFORTS.includes(body.output_config.effort)) reject('output_config.effort: invalid value');
    const messages = body.messages as { role: string; content: Json[] }[];
    if (messages[0]?.role !== 'user') reject('first message must use the "user" role');
    if (JSON.stringify(body).split('"cache_control"').length - 1 > 4) reject('A maximum of 4 blocks with cache_control may be provided');
    let previous: string | null = null;
    messages.forEach((message, index) => {
      for (const block of message.content) {
        if (block.type === 'text' && !block.text) reject(`messages.${index}: text content blocks must be non-empty`);
        if (block.type !== 'thinking') continue;
        const issued = this.signatures.get(block.signature);
        if (!issued) reject(`messages.${index}: Invalid signature in thinking block`);
        const prefix = canonical([body.system, body.tools, this.withoutThinking(messages.slice(0, index))]);
        if (issued!.prefix !== prefix || issued!.previous !== previous) {
          if (body.thinking?.block_binding?.prefix_mismatch_behavior !== 'drop_block') reject(`messages.${index}.content.0: The block is bound to a different conversation.`);
          this.dropped++;
        }
        previous = block.signature;
      }
      const uses = message.content.filter((block) => block.type === 'tool_use').map((block) => block.id);
      if (!uses.length) return;
      const results = (messages[index + 1]?.content ?? []).filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id);
      if (messages[index + 1]?.role !== 'user' || uses.some((id) => !results.includes(id)) || messages[index + 1]!.content[0]?.type !== 'tool_result') {
        reject(`messages.${index + 1}: tool_use ids were found without tool_result blocks immediately after`);
      }
    });
    const cached = this.cached('api.anthropic.com', canonical([body.system, body.tools, messages]));
    const usage = { input_tokens: 20, cache_read_input_tokens: cached, cache_creation_input_tokens: 100, output_tokens: 30 };
    const last = messages.at(-1)!;
    if (body.output_config?.format) return json({ content: [{ type: 'text', text: memoryJson }], stop_reason: 'end_turn', usage });
    const lastText = last.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const signature = `sig-${++this.serial}`;
    this.signatures.set(signature, { prefix: canonical([body.system, body.tools, this.withoutThinking(messages)]), previous });
    const tool = this.wantsTool(lastText, last.content.some((block) => block.type === 'tool_result'));
    if (!body.stream) reject('the agent always streams');
    return sse([
      { type: 'message_start', message: { usage } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
      { type: 'content_block_stop', index: 0 },
      ...(tool ? [
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu_${this.serial}`, name: 'get_code', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 1 },
      ] : [
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '先存再查会让同一个元素用两次。' } },
        { type: 'content_block_stop', index: 1 },
      ]),
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ]);
  }

  private withoutThinking(messages: { role: string; content: Json[] }[]) {
    return messages.map((message) => ({ ...message, content: message.content.filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking') }));
  }

  /** Chat Completions 共同的检查：工具结果紧跟在对应的调用后面 */
  private chatCommon(body: Json) {
    const messages = body.messages as Json[];
    messages.forEach((message, index) => {
      for (const call of message.tool_calls ?? []) {
        if (!messages.slice(index + 1).some((item) => item.role === 'tool' && item.tool_call_id === call.id)) reject(`tool call ${call.id} has no result`);
      }
    });
    const last = messages.at(-1)!;
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : (lastUser?.content as Json[] | undefined)?.map((part) => part.text).join('') ?? '';
    return { messages, tool: this.wantsTool(text, last.role === 'tool') };
  }

  private chatStream(host: string, body: Json, tool: boolean, reasoning: Json) {
    const cached = this.cached(host, canonical(body.messages));
    const id = `call_${++this.serial}`;
    return sse([
      { choices: [{ delta: { role: 'assistant', ...reasoning } }] },
      tool
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'get_code', arguments: '{}' } }] } }] }
        : { choices: [{ delta: { content: '先存再查会让同一个元素用两次。' } }] },
      { choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: cached + 50, completion_tokens: 20, prompt_tokens_details: { cached_tokens: cached }, prompt_cache_hit_tokens: cached } },
    ], true);
  }

  private chatTool(body: Json) {
    return json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_m', type: 'function', function: { name: body.tool_choice?.function?.name ?? 'save_memories', arguments: memoryJson } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  }

  private deepseek(url: URL, body: Json, headers: Record<string, string>, thirdParty = false) {
    if (url.pathname !== (thirdParty ? '/v1/chat/completions' : '/chat/completions') || headers.Authorization !== 'Bearer key') reject('wrong DeepSeek path or key');
    const thinking = thirdParty || body.thinking?.type !== 'disabled';
    if ('reasoning' in body) reject('Unknown parameter: reasoning');
    if ('reasoning_effort' in body && !['none', 'low', 'medium', 'high', 'max'].includes(body.reasoning_effort)) reject('reasoning_effort: invalid value');
    if (thinking && body.tool_choice && body.tool_choice !== 'auto' && body.tool_choice !== 'none') reject('required and named tool choices are not supported in thinking mode');
    const { messages, tool } = this.chatCommon(body);
    if (thinking && body.tools) {
      for (const message of messages) if (message.role === 'assistant' && typeof message.reasoning_content !== 'string') reject('reasoning_content must be passed back');
    }
    if (!body.stream) return this.chatTool(body);
    return this.chatStream(url.hostname, body, tool, { reasoning_content: '先看看代码' });
  }

  private openai(url: URL, body: Json, headers: Record<string, string>) {
    if (url.pathname !== '/v1/responses' || headers.Authorization !== 'Bearer key') reject('wrong OpenAI path or key');
    if (body.store !== false) reject('the extension never stores responses');
    if ('reasoning_effort' in body) reject('Unknown parameter: reasoning_effort');
    if (body.reasoning && !['none', ...EFFORTS].includes(body.reasoning.effort)) reject('reasoning.effort: invalid value');
    if (body.prompt_cache_options && !/^gpt-(?:5\.[6-9]|[6-9])/.test(body.model)) reject('prompt_cache_options is not supported for this model');
    const input = body.input as Json[];
    const calls = new Set(input.filter((item) => item.type === 'function_call').map((item) => item.call_id));
    for (const item of input) {
      if (item.type === 'function_call_output' && !calls.has(item.call_id)) reject(`No tool call found for function call output with call_id ${item.call_id}`);
      if (item.type === 'reasoning' && !String(item.encrypted_content).startsWith('enc-')) reject('reasoning item without encrypted content');
    }
    const reasoning = { type: 'reasoning', id: `rs_${++this.serial}`, encrypted_content: `enc-${this.serial}`, summary: [] };
    const usage = { input_tokens: 0, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
    if (body.tool_choice?.type === 'function') {
      return json({ status: 'completed', usage, output: [reasoning, { type: 'function_call', id: 'fc_m', call_id: 'call_m', name: body.tool_choice.name, arguments: memoryJson }] });
    }
    const cached = this.cached('api.openai.com', canonical([body.instructions, body.tools, input]));
    usage.input_tokens = cached + 50;
    usage.input_tokens_details.cached_tokens = cached;
    const last = input.at(-1)!;
    const lastUser = [...input].reverse().find((item) => item.role === 'user');
    const tool = this.wantsTool(String(lastUser?.content ?? ''), last.type === 'function_call_output');
    const output = [reasoning, tool
      ? { type: 'function_call', id: `fc_${this.serial}`, call_id: `call_${this.serial}`, name: 'get_code', arguments: '{}' }
      : { type: 'message', id: `msg_${this.serial}`, role: 'assistant', content: [{ type: 'output_text', text: '先存再查会让同一个元素用两次。' }] }];
    return sse([
      ...(tool ? [] : [{ type: 'response.output_text.delta', delta: '先存再查会让同一个元素用两次。' }]),
      { type: 'response.completed', response: { status: 'completed', output, usage } },
    ]);
  }

  private openrouter(url: URL, body: Json, headers: Record<string, string>) {
    if (url.pathname !== '/api/v1/chat/completions' || headers.Authorization !== 'Bearer key') reject('wrong OpenRouter path or key');
    const routed = routedVendor(body.model);
    if (body.stream && !body.session_id) reject('the agent pins each conversation with session_id');
    if ('reasoning_effort' in body && 'reasoning' in body) reject('use either reasoning or reasoning_effort');
    if (body.reasoning?.effort && !['none', 'minimal', ...EFFORTS].includes(body.reasoning.effort)) reject('reasoning.effort: invalid value');
    if (routed === 'anthropic') {
      if (body.tool_choice && body.tool_choice !== 'auto') reject('tool_choice: type "tool" and "any" are not supported for this model.');
      if (body.reasoning?.enabled === false || body.reasoning?.effort === 'none') reject('Reasoning is mandatory for this endpoint and cannot be disabled.');
    }
    if (routed === 'deepseek' && body.tool_choice?.type === 'function' && body.reasoning?.enabled !== false) reject('named tool choices are not supported in thinking mode');
    const { tool } = this.chatCommon(body);
    if (!body.stream) {
      if (body.response_format?.type === 'json_schema') return json({ choices: [{ message: { role: 'assistant', content: memoryJson } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      return this.chatTool(body);
    }
    const details = routed === 'openai'
      ? [{ type: 'reasoning.encrypted', data: `enc-${this.serial}`, format: 'openai-responses-v1', index: 0 }]
      : [{ type: 'reasoning.text', text: '先看看代码', signature: routed === 'anthropic' ? `sig-${this.serial}` : null, format: 'anthropic-claude-v1', index: 0 }];
    return this.chatStream('openrouter.ai', body, tool, { reasoning: '先看看代码', reasoning_details: details });
  }
}

describe('recommended models against simulated services', () => {
  let services: MockServices;
  const original = globalThis.fetch;
  beforeEach(() => { services = new MockServices(); globalThis.fetch = services.fetch as typeof fetch; });
  afterEach(() => { globalThis.fetch = original; });

  const cases = PROVIDERS.flatMap((provider) => provider.models.map((model) => [provider.id, model.id] as [Vendor, string]));
  it.each(cases)('%s / %s goes through three turns, a trim and memory extraction', async (vendor, model) => {
    const outcome = await runProvider(vendor, model, 'key');
    expect(services.errors).toEqual([]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(outcome.turns[0]!.steps.map((step) => step.tools)).toEqual([['get_code'], []]);
    expect(outcome.secondTurnCached).toBeGreaterThan(0);
    expect(outcome.afterTrimOk).toBe(true);
    // 裁剪之后作废的思考块插件自己删掉了，用不着服务端丢弃
    expect(services.dropped).toBe(0);
  });

  /** 每家回答用的思考强度字段；整理记忆的请求不该带上设置里的值 */
  const effortOf = (host: string, body: Json) => host === 'api.anthropic.com' ? body.output_config?.effort
    : host === 'api.deepseek.com' ? body.reasoning_effort : body.reasoning?.effort;
  it.each(cases)('%s / %s uses the effort chosen in settings for answers only', async (vendor, model) => {
    const outcome = await runProvider(vendor, model, 'key', 'high');
    expect(services.errors).toEqual([]);
    expect(outcome.ok).toBe(true);
    const answers = services.requests.filter((request) => request.body.stream);
    expect(answers.length).toBeGreaterThan(3);
    expect(answers.every((request) => effortOf(request.host, request.body) === 'high')).toBe(true);
    const memory = services.requests.filter((request) => !request.body.stream);
    expect(memory.length).toBeGreaterThan(0);
    expect(memory.some((request) => effortOf(request.host, request.body) === 'high')).toBe(false);
  });

  it('recognises an OpenRouter alias by its vendor', async () => {
    const outcome = await runProvider('openrouter', '~anthropic/claude-sonnet-latest', 'key');
    expect(services.errors).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(services.requests.find((request) => request.body.stream)!.body.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sends a third-party DeepSeek its own reasoning back, and asks for the tool in the prompt once forcing is refused', async () => {
    const outcome = await runSettings({ baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V4.1-Flash', apiKey: 'key' }, '第三方 DeepSeek');
    expect(outcome.error).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(outcome.secondTurnCached).toBeGreaterThan(0);
    // 记忆整理先强制调用工具被拒一次，改成在提示里要求后成功
    expect(services.errors).toEqual(['required and named tool choices are not supported in thinking mode']);
    const retry = services.requests.at(-1)!.body;
    expect(retry.tool_choice).toBe('auto');
    expect(retry.messages[0].content).toContain('调用 save_memories 工具');
  });

  it('the simulated Claude service really checks thinking blocks, so the checks above mean something', async () => {
    await runProvider('anthropic', 'claude-sonnet-5-5', 'key');
    type Message = { role: string; content: Json[] };
    // 找一次请求：工具结果后面还有带思考块的回复。改掉工具结果、思考块原样留着
    const before = services.requests.find((request) => request.host === 'api.anthropic.com' && request.body.stream &&
      (request.body.messages as Message[]).some((message, index, all) => message.role === 'assistant' &&
        message.content.some((block) => block.type === 'thinking') && all.slice(0, index).some((item) => item.content.some((block) => block.type === 'tool_result'))))!;
    const messages = structuredClone(before.body.messages) as Message[];
    messages.flatMap((message) => message.content).find((block) => block.type === 'tool_result')!.content = 'changed';
    const send = (thinking?: object) => services.fetch('https://api.anthropic.com/v1/messages', {
      body: JSON.stringify({ ...before.body, messages, thinking }), headers: before.headers,
    });
    expect((await send()).status).toBe(400);
    const dropped = services.dropped;
    expect((await send({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } })).status).toBe(200);
    expect(services.dropped).toBeGreaterThan(dropped);
  });
});
