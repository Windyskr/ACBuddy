import type { AgentMessage, AgentSettings, ToolCall } from './agent';

export type ApiType = 'responses' | 'chat-completions';
export interface ResponseItem { type: string; [key: string]: unknown }
interface FunctionTool {
  type: string;
  function: { name: string; description: string; parameters: object };
}

export function endpointFor(baseUrl: string, apiType: ApiType = 'responses') {
  const url = new URL(baseUrl.trim());
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('API 地址需要使用 HTTPS；本地服务可以使用 HTTP');
  }
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/(?:responses|chat\/completions)$/, '');
  url.pathname = `${basePath}/${apiType === 'chat-completions' ? 'chat/completions' : 'responses'}`;
  return url;
}

export function modelRequest(settings: AgentSettings, messages: AgentMessage[], instructions: string, tools: FunctionTool[], stream = false) {
  if (settings.apiType === 'chat-completions') {
    return {
      model: settings.model, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), tools, tool_choice: 'auto',
      messages: [{ role: 'system', content: instructions }, ...messages.map(({ role, content, tool_calls, tool_call_id }) => ({
        role, content, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}),
      }))],
    };
  }
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
  return {
    model: settings.model, instructions, input,
    tools: tools.map(({ function: definition }) => ({ type: 'function', ...definition, strict: true })),
    tool_choice: 'auto', stream, store: false, include: ['reasoning.encrypted_content'],
  };
}

export function modelReply(body: unknown, apiType: ApiType = 'responses'): AgentMessage {
  if (!body || typeof body !== 'object') throw new Error('模型响应格式无效');
  if (apiType === 'chat-completions') {
    const reply = (body as { choices?: { message?: AgentMessage }[] }).choices?.[0]?.message;
    if (!reply || (reply.content != null && typeof reply.content !== 'string') ||
      (reply.tool_calls != null && !Array.isArray(reply.tool_calls))) throw new Error('模型响应格式无效，需要支持工具调用的 Chat Completions 服务');
    return { role: 'assistant', content: reply.content ?? null, ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}) };
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

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中提示缓存的输入 token，服务不报告时为 0 */
  cachedTokens: number;
}

/** 两种接口的用量字段名不一样，没有返回时都算 0 */
export function usageOf(body: unknown): ModelUsage {
  const usage = (body as { usage?: Record<string, number> & { input_tokens_details?: { cached_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } } } | null)?.usage;
  return {
    inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
    cachedTokens: usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/** 逐条读 SSE 的 data。网络分块不按行对齐，要自己攒到换行 */
async function* sseData(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += value;
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface ModelResult {
  reply: AgentMessage;
  usage: ModelUsage;
  /** 从发出请求到第一个文字或工具调用片段的毫秒数，非流式响应为 null */
  firstTokenMs: number | null;
}

/**
 * 读取流式响应，文字边到边通过 onText 给出（累计的全文）。服务没按流式返回时按普通 JSON 解析，
 * 结果和 modelReply 一样。onChunk 在每次收到数据时调用，用来重置空闲超时。
 */
export async function readModelStream(response: Response, apiType: ApiType, startedAt: number, handlers: { onText(text: string): void; onChunk?(): void }): Promise<ModelResult> {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    const body = await response.json();
    return { reply: modelReply(body, apiType), usage: usageOf(body), firstTokenMs: null };
  }
  let firstTokenMs: number | null = null;
  const firstToken = () => { firstTokenMs ??= performance.now() - startedAt; };
  if (apiType === 'chat-completions') {
    let text = '';
    const calls: { id?: string; name?: string; arguments: string }[] = [];
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    for await (const data of sseData(response)) {
      handlers.onChunk?.();
      if (data === '[DONE]') break;
      let chunk: { error?: { message?: string }; usage?: unknown; choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(chunk.error.message ?? '模型返回了错误');
      if (chunk.usage) usage = usageOf(chunk);
      const delta = chunk.choices?.[0]?.delta;
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
    return { reply: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, usage, firstTokenMs };
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
      return { reply: modelReply(event.response, 'responses'), usage: usageOf(event.response), firstTokenMs };
    } else if (event.type === 'error') throw new Error(event.message ?? event.error?.message ?? '模型返回了错误');
  }
  throw new Error('模型的响应中断了，请重试');
}
