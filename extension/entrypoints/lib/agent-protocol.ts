import type { AgentMessage, AgentSettings, Effort, ToolCall } from './agent';
import { SITE_URL } from './api';
import { claudeHeaders, claudeReply, claudeRequest, claudeSchema, claudeStructuredRequest, claudeUsage, readClaudeStream } from './protocol-anthropic';
import { hostOf, sseData, toolInstruction, type ModelResult, type ModelUsage, type StreamHandlers } from './protocol-common';
import { apiTypeOfUrl, hasCacheOptions, routedVendor, vendorOf } from './providers';

export type { ModelResult, ModelUsage } from './protocol-common';
export type ApiType = 'responses' | 'chat-completions' | 'anthropic';
export interface ResponseItem { type: string; [key: string]: unknown }
interface FunctionTool {
  type: string;
  function: { name: string; description: string; parameters: object };
}
interface StructuredRequest {
  system?: string;
  messages: AgentMessage[];
  tool?: { name: string; description: string; parameters: object };
}

const apiTypeOf = (settings: AgentSettings): ApiType => apiTypeOfUrl(settings.baseUrl);

export function endpointFor(baseUrl: string, apiType: ApiType = 'responses') {
  const url = new URL(baseUrl.trim());
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('API 地址需要使用 HTTPS；本地服务可以使用 HTTP');
  }
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/(?:responses|chat\/completions|messages)$/, '');
  // Claude 的地址习惯不带 /v1（官方是 https://api.anthropic.com，DeepSeek 的兼容接口是 …/anthropic），缺了就补上
  if (apiType === 'anthropic') url.pathname = `${basePath.endsWith('/v1') ? basePath : `${basePath}/v1`}/messages`;
  else url.pathname = `${basePath}/${apiType === 'chat-completions' ? 'chat/completions' : 'responses'}`;
  return url;
}

function modelHeaders(settings: AgentSettings, body: Record<string, unknown>): Record<string, string> {
  if (apiTypeOf(settings) === 'anthropic') return claudeHeaders(settings, body);
  return {
    'Content-Type': 'application/json',
    ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
    // OpenRouter 按这两个头显示是哪个应用发的请求，可选
    ...(vendorOf(settings.baseUrl) === 'openrouter' ? { 'HTTP-Referer': SITE_URL, 'X-OpenRouter-Title': 'ACBuddy' } : {}),
  };
}

/** 发一次模型请求。三种接口的地址、鉴权和版本头不一样，都在这里处理 */
export function postModel(settings: AgentSettings, body: Record<string, unknown>, signal: AbortSignal) {
  return fetch(endpointFor(settings.baseUrl, apiTypeOf(settings)), {
    method: 'POST', credentials: 'omit', redirect: 'error',
    headers: modelHeaders(settings, body), body: JSON.stringify(body), signal,
  });
}

/** OpenRouter 上的模型来自哪家。缓存、推理和强制调用工具的规矩跟着原厂走 */
const routedOf = (settings: AgentSettings) => (vendorOf(settings.baseUrl) === 'openrouter' ? routedVendor(settings.model) : null);
/** 经 OpenRouter 调 Claude 用的缓存标记。用默认的 5 分钟：闲置 10 分钟后可能换服务商，1 小时缓存多付的写入钱会白花 */
const CLAUDE_CACHE = { type: 'ephemeral' };

/** 推理内容按服务的要求发回去，别家不认这些字段就不发 */
function reasoningFor(settings: AgentSettings, message: AgentMessage) {
  const vendor = vendorOf(settings.baseUrl);
  // DeepSeek 思考模式带工具调用时，之后每次请求都要带上 reasoning_content，缺了报 400。
  // 换过模型的对话里别家的回复没有，给空串
  if (vendor === 'deepseek') return { reasoning_content: message.reasoningContent ?? '' };
  // OpenRouter 原样发回 reasoning_details（Claude 的思考签名、OpenAI 的加密推理都在里面），没有就发推理文字
  if (vendor === 'openrouter') {
    if (message.reasoningDetails?.length) return { reasoning_details: message.reasoningDetails };
    if (message.reasoningContent) return { reasoning: message.reasoningContent };
    return {};
  }
  // 别的服务（第三方托管的 DeepSeek、Kimi 等）回过 reasoning_content 的，原样发回给它自己。
  // 换过服务的对话里，别家回的不发，免得不认识这个字段的服务报错
  if (message.reasoningContent && message.reasoningHost === hostOf(settings.baseUrl)) return { reasoning_content: message.reasoningContent };
  return {};
}

function chatMessages(settings: AgentSettings, messages: AgentMessage[], instructions: string, cache: boolean) {
  const list = messages.map((message) => ({
    role: message.role, content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.role === 'assistant' ? reasoningFor(settings, message) : {}),
  }));
  const all: { role: string; content: unknown }[] = [...(instructions ? [{ role: 'system', content: instructions }] : []), ...list];
  if (!cache || routedOf(settings) !== 'anthropic') return all;
  // Claude 的缓存要标出来：题目信息标一处，后面怎么变它都能命中；对话末尾交给请求顶层的自动标记
  const first = all.findIndex((message) => message.role === 'user');
  return all.map((message, index) => index === first && typeof message.content === 'string' && message.content
    ? { ...message, content: [{ type: 'text', text: message.content, cache_control: CLAUDE_CACHE }] } : message);
}

/** 各家在 Chat Completions 上的附加参数。思考强度 DeepSeek 用 reasoning_effort（它只有低、高两档，中按高算），OpenRouter 用 reasoning.effort */
function chatExtras(settings: AgentSettings, conversationId: string | undefined, cache: boolean, effort: Effort | undefined) {
  if (vendorOf(settings.baseUrl) !== 'openrouter') return effort ? { reasoning_effort: effort } : {};
  const routed = routedOf(settings);
  // 经 OpenRouter 调 Claude 默认也用 medium，和官方接口一样
  const reasoning = effort ?? (routed === 'anthropic' ? 'medium' : undefined);
  return {
    // 同一段对话一直发给同一家服务商，缓存才能命中；不给的话要等命中过一次缓存才开始固定
    ...(conversationId ? { session_id: `acb-${conversationId}` } : {}),
    ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
    ...(routed === 'anthropic' && cache ? { cache_control: CLAUDE_CACHE } : {}),
  };
}

function responsesInput(messages: AgentMessage[]) {
  const input: object[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
    } else if (message.role === 'assistant' && message.responsesOutput) {
      // Replay every output item in order, including encrypted reasoning and phase.
      input.push(...message.responsesOutput);
    } else {
      if (message.content) input.push({ role: message.role, content: message.content });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  return input;
}

/** 只有 OpenAI 官方认得的缓存参数：同一段对话路由到同一台机器，缓存才容易命中 */
const openaiCache = (settings: AgentSettings, conversationId?: string) =>
  vendorOf(settings.baseUrl) === 'openai' && conversationId ? { prompt_cache_key: `acb-${conversationId}` } : {};

/**
 * 回答用户的请求。共用开头的摘要也走这里，除了 stream 参数完全一样，前面的部分才能命中缓存。
 * effort 是设置里选的思考强度，只用在回答上，整理记忆的请求不传
 */
export function modelRequest(settings: AgentSettings, messages: AgentMessage[], instructions: string, tools: FunctionTool[], { stream = false, conversationId, cache = true, effort }: { stream?: boolean; conversationId?: string; cache?: boolean; effort?: Effort } = {}): Record<string, unknown> {
  const apiType = apiTypeOf(settings);
  if (apiType === 'anthropic') return claudeRequest(settings, messages, instructions, tools, stream, effort);
  if (apiType === 'chat-completions') {
    return {
      model: settings.model, stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      messages: chatMessages(settings, messages, instructions, cache),
      ...chatExtras(settings, conversationId, cache, effort),
    };
  }
  return {
    model: settings.model, ...(instructions ? { instructions } : {}), input: responsesInput(messages),
    ...(tools.length ? { tools: tools.map(({ function: definition }) => ({ type: 'function', ...definition, strict: true })), tool_choice: 'auto' } : {}),
    stream, store: false, include: ['reasoning.encrypted_content'],
    ...(effort ? { reasoning: { effort } } : {}),
    ...openaiCache(settings, conversationId),
  };
}

/**
 * 记忆整理用的请求：要一个符合格式的结果，不用缓存（每次内容都不一样，标了缓存反而多付写入的钱）。
 * 能强制调用工具的就强制调用；DeepSeek 思考模式下不能强制调用，先关掉思考（整理记忆用不着）；
 * Claude 新模型不能强制调用，改用结构化输出（官方接口见 claudeStructuredRequest）
 */
export function structuredRequest(settings: AgentSettings, request: StructuredRequest, { force = true }: { force?: boolean } = {}): Record<string, unknown> {
  const apiType = apiTypeOf(settings);
  if (apiType === 'anthropic') return claudeStructuredRequest(settings, request);
  const { tool } = request;
  const routed = routedOf(settings);
  const json = tool && routed === 'anthropic';
  // 不强制时在提示里要求调用工具（见 modelLlm：有的服务不接受强制调用，报 400 后这样再试一次）
  const system = tool && !json && !force ? `${request.system ?? ''}\n\n${toolInstruction(tool.name)}`.trim() : request.system ?? '';
  const body = modelRequest(settings, request.messages, system, tool && !json ? [{ type: 'function', function: tool }] : [], { cache: false });
  if (routed === 'anthropic') body.reasoning = { effort: 'low' };
  // GPT-5.6 默认自动缓存，写入按 1.25 倍计价；这种一次性的请求没有下一次来读，关掉（显式模式且不标断点就是不缓存）。
  // 官方文档只写了 Responses 支持这个字段；OpenRouter 两种接口都支持
  const openai = (vendorOf(settings.baseUrl) === 'openai' && apiType === 'responses') || routed === 'openai';
  if (openai && hasCacheOptions(settings.model)) body.prompt_cache_options = { mode: 'explicit' };
  if (!tool) return body;
  if (json) return { ...body, response_format: { type: 'json_schema', json_schema: { name: tool.name, strict: true, schema: claudeSchema(tool.parameters) } } };
  if (!force) return body;
  if (apiType === 'responses') return { ...body, tool_choice: { type: 'function', name: tool.name } };
  return {
    ...body, tool_choice: { type: 'function', function: { name: tool.name } },
    ...(vendorOf(settings.baseUrl) === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    ...(routed === 'deepseek' ? { reasoning: { enabled: false } } : {}),
  };
}

/** 这个请求是不是强制调用了工具。不接受强制调用的服务会报 400，modelLlm 据此改成不强制再试 */
export const forcesTool = (body: Record<string, unknown>) => typeof body.tool_choice === 'object' && body.tool_choice !== null;

export interface StructuredReply { text: string; toolArguments: string | null; usage: ModelUsage }

/** 结构化请求的结果：工具参数，或者 Claude 结构化输出的那段 JSON */
export function structuredReply(settings: AgentSettings, body: unknown, request: StructuredRequest): StructuredReply {
  const reply = modelReply(body, settings);
  const usage = usageFor(settings, body);
  const call = reply.tool_calls?.find((item) => item.function.name === request.tool?.name);
  if (!request.tool) return { text: reply.content ?? '', toolArguments: null, usage };
  if (call) return { text: reply.content ?? '', toolArguments: call.function.arguments, usage };
  // 结构化输出直接是 JSON 文字；没按要求调用工具、但回了 JSON 的也认
  const text = reply.content?.trim().replace(/^```(?:json)?\s*|\s*```$/g, '') ?? '';
  try {
    JSON.parse(text);
    return { text: '', toolArguments: text, usage };
  } catch {
    throw new Error('模型没有按要求返回结构化结果');
  }
}

const reasoningText = (value: unknown, settings: AgentSettings) => (typeof value === 'string' && value ? { reasoningContent: value, reasoningHost: hostOf(settings.baseUrl) } : {});

export function modelReply(body: unknown, settings: AgentSettings): AgentMessage {
  if (!body || typeof body !== 'object') throw new Error('模型响应格式无效');
  const apiType = apiTypeOf(settings);
  if (apiType === 'anthropic') return claudeReply(body);
  if (apiType === 'chat-completions') {
    const reply = (body as { choices?: { message?: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown } }[] }).choices?.[0]?.message;
    if (!reply || (reply.content != null && typeof reply.content !== 'string') ||
      (reply.tool_calls != null && !Array.isArray(reply.tool_calls))) throw new Error('模型响应格式无效，需要支持工具调用的 Chat Completions 服务');
    const calls = reply.tool_calls as ToolCall[] | undefined;
    return {
      role: 'assistant', content: (reply.content as string | null | undefined) ?? null,
      ...(calls?.length ? { tool_calls: calls } : {}),
      ...reasoningText(reply.reasoning_content ?? reply.reasoning, settings),
      ...(Array.isArray(reply.reasoning_details) && reply.reasoning_details.length ? { reasoningDetails: reply.reasoning_details } : {}),
    };
  }
  const response = body as { status?: string; output?: ResponseItem[]; error?: unknown };
  if (response.error || (response.status && response.status !== 'completed')) {
    throw new Error(response.status === 'incomplete' ? '模型生成未完成，请检查服务的输出限制后重试' : 'Responses 请求未完成，请检查模型服务后重试');
  }
  if (!Array.isArray(response.output)) throw new Error('模型响应格式无效，需要支持 Responses API 的服务');
  const text: string[] = [];
  const calls: ToolCall[] = [];
  for (const item of response.output) {
    if (!item || typeof item.type !== 'string') throw new Error('Responses 返回了无效的输出项');
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') {
        throw new Error('Responses 返回了无效的工具调用');
      }
      calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) throw new Error('Responses 返回了无效的消息');
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
        else if (part?.type === 'refusal' && typeof part.refusal === 'string') text.push(part.refusal);
        else throw new Error('Responses 返回了无法读取的消息内容');
      }
    } else if (item.type !== 'reasoning') {
      throw new Error(`Responses 返回了不支持的输出类型：${item.type}`);
    }
  }
  return {
    role: 'assistant', content: text.length ? text.join('\n\n') : null,
    ...(calls.length ? { tool_calls: calls } : {}), responsesOutput: response.output,
  };
}

/** OpenAI 两种接口的用量。DeepSeek 另报 prompt_cache_hit_tokens，OpenRouter 另报写入缓存的 token。没有返回时都算 0 */
export function usageOf(body: unknown): ModelUsage {
  type Details = { cached_tokens?: number; cache_write_tokens?: number };
  const usage = (body as { usage?: Record<string, number> & { input_tokens_details?: Details; prompt_tokens_details?: Details } } | null)?.usage;
  const details = usage?.input_tokens_details ?? usage?.prompt_tokens_details;
  const write = details?.cache_write_tokens ?? 0;
  return {
    inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
    cachedTokens: details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
    ...(write ? { cacheWriteTokens: write } : {}),
  };
}

export const usageFor = (settings: AgentSettings, body: unknown) =>
  apiTypeOf(settings) === 'anthropic' ? claudeUsage((body as { usage?: unknown } | null)?.usage) : usageOf(body);

/** OpenRouter 流式返回的推理记录是一段段的，按 index 拼回完整的一条 */
function mergeReasoning(details: Record<string, unknown>[], parts: unknown) {
  if (!Array.isArray(parts)) return;
  for (const part of parts as Record<string, unknown>[]) {
    const index = typeof part.index === 'number' ? part.index : details.length;
    const current = details[index];
    if (!current) { details[index] = { ...part }; continue; }
    for (const [key, value] of Object.entries(part)) {
      // 后面的片段常带着空的 signature，不能把前面拿到的盖掉
      if (value == null) continue;
      current[key] = typeof value === 'string' && typeof current[key] === 'string' && (key === 'text' || key === 'summary' || key === 'data')
        ? current[key] + value : value;
    }
  }
}

/**
 * 读取流式响应，文字边到边通过 onText 给出（累计的全文）。服务没按流式返回时按普通 JSON 解析，
 * 结果和 modelReply 一样。onChunk 在每次收到数据时调用，用来重置空闲超时。
 */
export async function readModelStream(response: Response, settings: AgentSettings, startedAt: number, handlers: StreamHandlers): Promise<ModelResult> {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    const body = await response.json();
    return { reply: modelReply(body, settings), usage: usageFor(settings, body), firstTokenMs: null };
  }
  const apiType = apiTypeOf(settings);
  if (apiType === 'anthropic') return readClaudeStream(response, startedAt, handlers);
  let firstTokenMs: number | null = null;
  const firstToken = () => { firstTokenMs ??= performance.now() - startedAt; };
  if (apiType === 'chat-completions') {
    let text = '';
    let reasoning = '';
    const details: Record<string, unknown>[] = [];
    const calls: { id?: string; name?: string; arguments: string }[] = [];
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    for await (const data of sseData(response)) {
      handlers.onChunk?.();
      if (data === '[DONE]') break;
      let chunk: { error?: { message?: string }; usage?: unknown; choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; reasoning_details?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(chunk.error.message ?? '模型返回了错误');
      if (chunk.usage) usage = usageOf(chunk);
      const delta = chunk.choices?.[0]?.delta;
      reasoning += delta?.reasoning_content ?? delta?.reasoning ?? '';
      mergeReasoning(details, delta?.reasoning_details);
      if (delta?.content) {
        firstToken();
        text += delta.content;
        handlers.onText(text);
      }
      for (const part of delta?.tool_calls ?? []) {
        firstToken();
        const call = (calls[part.index ?? 0] ??= { arguments: '' });
        call.id ??= part.id;
        call.name ??= part.function?.name;
        call.arguments += part.function?.arguments ?? '';
      }
    }
    const toolCalls: ToolCall[] = calls.filter(Boolean).map((call) => ({ id: call.id ?? '', type: 'function', function: { name: call.name ?? '', arguments: call.arguments } }));
    const kept = details.filter(Boolean);
    return {
      reply: {
        role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...reasoningText(reasoning, settings), ...(kept.length ? { reasoningDetails: kept } : {}),
      },
      usage, firstTokenMs,
    };
  }
  let text = '';
  for await (const data of sseData(response)) {
    handlers.onChunk?.();
    let event: { type?: string; delta?: string; response?: unknown; error?: { message?: string }; message?: string };
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'response.output_text.delta' && event.delta) {
      firstToken();
      text += event.delta;
      handlers.onText(text);
    } else if (event.type === 'response.function_call_arguments.delta') firstToken();
    else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      return { reply: modelReply(event.response, settings), usage: usageOf(event.response), firstTokenMs };
    } else if (event.type === 'error') throw new Error(event.message ?? event.error?.message ?? '模型返回了错误');
  }
  throw new Error('模型的响应中断了，请重试');
}
