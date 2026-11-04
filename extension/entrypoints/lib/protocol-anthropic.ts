import type { AgentMessage, AgentSettings, Effort, ToolCall } from './agent';
import { ContextTooLongError, hostOf, RefusalError, sseData, toolInstruction, type ModelResult, type ModelUsage, type StreamHandlers } from './protocol-common';

// Claude 的 Messages API。和另外两种接口最大的不同：
// - 回复是内容块列表，思考块带签名，要原样发回去，所以整个列表存在消息的 claudeContent 上。
// - Sonnet 5.5 这一代的思考块绑定在产生它的那段对话上：之前的消息改过，之后的思考块就作废，
//   新账号上直接报 400。插件自己裁工具结果、摘要的时候会删掉作废的思考块（见 context.ts 的 dropStaleReasoning），
//   官方接口再加上 drop_block，有漏掉的也只是丢弃，不会报错。
// - 缓存不会自动生效，要在请求里标出来。

const OFFICIAL_HOST = 'api.anthropic.com';
/** 官方接口用新的 API 版本；兼容服务多半只认旧版本号，插件用到的字段两个版本都一样 */
const API_VERSION = '2026-10-21';
const COMPAT_API_VERSION = '2023-06-01';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** 4.6 以后的模型才有自适应思考和 effort，更早的模型（Haiku 4.5 等）收到这两个字段会报错 */
const ADAPTIVE = /^claude-(?:(?:opus|sonnet)-4-[6-9]|[a-z]+-[5-9])/;
/** 被安全分类器拒绝时，官方接口能自动换个模型接着回答（fallbacks: "default"），只有这几个模型支持 */
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);
/** 每一步的输出上限，含思考。设得太大会让低等级账号一开始就被输出速率限制挡住 */
const MAX_TOKENS = 16_000;
const STRUCTURED_MAX_TOKENS = 8_000;

export interface ClaudeBlock { type: string; [key: string]: unknown }
interface ClaudeMessage { role: 'user' | 'assistant'; content: ClaudeBlock[] }
interface FunctionTool { type: string; function: { name: string; description: string; parameters: object } }

export const isOfficialClaude = (baseUrl: string) => hostOf(baseUrl) === OFFICIAL_HOST;
const adaptive = (model: string) => ADAPTIVE.test(model);

export function claudeHeaders(settings: AgentSettings, body: Record<string, unknown>): Record<string, string> {
  const official = isOfficialClaude(settings.baseUrl);
  const betas = [
    ...((body.thinking as { block_binding?: unknown } | undefined)?.block_binding ? [BINDING_BETA] : []),
    ...(body.fallbacks ? [FALLBACK_BETA] : []),
  ];
  return {
    'Content-Type': 'application/json',
    ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}),
    'anthropic-version': official ? API_VERSION : COMPAT_API_VERSION,
    // 官方接口要求浏览器里发起的请求带上这个头，表示知道密钥在浏览器里。密钥是用户自己的，只存在本机
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}),
  };
}

/** Claude 的工具调用 id 只能有字母、数字、下划线和短横线，换过模型的对话里可能有别家的 id */
const toolId = (id: string | undefined) => (id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
const toolInput = (args: string) => {
  try {
    const value: unknown = JSON.parse(args || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

/** 转成 Claude 的消息：工具结果并进一条用户消息，相邻的同角色消息合并 */
export function claudeMessages(messages: AgentMessage[]): ClaudeMessage[] {
  const result: ClaudeMessage[] = [];
  const push = (role: ClaudeMessage['role'], blocks: ClaudeBlock[]) => {
    if (!blocks.length) return;
    const last = result.at(-1);
    if (last?.role === role) last.content = [...last.content, ...blocks];
    else result.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: toolId(message.tool_call_id), content: message.content || '{}' }]);
    } else if (message.role === 'assistant') {
      // 别的接口产生的回复（对话中途换过模型）没有内容块，按文字和工具调用重建
      push('assistant', message.claudeContent ?? [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({ type: 'tool_use', id: toolId(call.id), name: call.function.name, input: toolInput(call.function.arguments) })),
      ]);
    } else if (message.content) push('user', [{ type: 'text', text: message.content }]);
  }
  return result;
}

/**
 * 标两个缓存断点：题目信息（对话里最长、一直不变的部分，后面怎么变它都能命中），和请求的最后一块（下一次从这里接着读）。
 * 官方接口用 1 小时的缓存：辅导时两次提问之间常隔 5 到 60 分钟，正好是 1 小时缓存比 5 分钟划算的区间
 */
function withCacheMarks(messages: ClaudeMessage[], official: boolean): ClaudeMessage[] {
  const mark = official ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  return messages.map((message, index) => {
    const marked = new Set<number>();
    if (index === 0) marked.add(0);
    if (index === messages.length - 1) marked.add(message.content.length - 1);
    return marked.size ? { ...message, content: message.content.map((block, i) => (marked.has(i) ? { ...block, cache_control: mark } : block)) } : message;
  });
}

const claudeTools = (tools: FunctionTool[]) => tools.map(({ function: definition }) => ({
  name: definition.name, description: definition.description, input_schema: definition.parameters,
}));

/**
 * 回答用户的请求。effort 默认取 medium：Sonnet 5.5 的建议是多步工具调用从 medium 开始；
 * 共用开头的摘要也走这里，参数一样才能命中缓存（effort 和思考设置一变，消息部分的缓存就失效）
 */
export function claudeRequest(settings: AgentSettings, messages: AgentMessage[], instructions: string, tools: FunctionTool[], stream: boolean, effort?: Effort) {
  const official = isOfficialClaude(settings.baseUrl);
  return {
    model: settings.model, max_tokens: MAX_TOKENS, stream,
    ...(instructions ? { system: [{ type: 'text', text: instructions }] } : {}),
    ...(tools.length ? { tools: claudeTools(tools) } : {}),
    messages: withCacheMarks(claudeMessages(messages), official),
    ...(adaptive(settings.model) ? {
      ...(official ? { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } } : {}),
      output_config: { effort: effort ?? 'medium' },
    } : {}),
    ...(official && FALLBACK_MODELS.has(settings.model) ? { fallbacks: 'default' } : {}),
  };
}

/** Claude 结构化输出不支持数值和长度约束，类型数组改写成 anyOf */
export function claudeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(claudeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(key)) continue;
    result[key] = key === 'properties'
      ? Object.fromEntries(Object.entries(value as object).map(([name, property]) => [name, claudeSchema(property)]))
      : claudeSchema(value);
  }
  if (Array.isArray(result.type)) {
    const { type, ...rest } = result;
    return { ...rest, anyOf: (type as string[]).map((item) => ({ type: item })) };
  }
  return result;
}

/**
 * 记忆整理用的请求：要一个符合格式的 JSON。Sonnet 5.5 不允许强制调用工具，
 * 官方接口用结构化输出（output_config.format）；兼容服务不一定支持，改成给工具并在提示里要求调用
 */
export function claudeStructuredRequest(settings: AgentSettings, request: { system?: string; messages: AgentMessage[]; tool?: { name: string; description: string; parameters: object } }) {
  const official = isOfficialClaude(settings.baseUrl);
  const effort = adaptive(settings.model) ? { effort: 'low' } : {};
  const { tool } = request;
  const system = tool && !official ? `${request.system ?? ''}\n\n${toolInstruction(tool.name)}`.trim() : request.system;
  return {
    model: settings.model, max_tokens: STRUCTURED_MAX_TOKENS,
    ...(system ? { system: [{ type: 'text', text: system }] } : {}),
    messages: claudeMessages(request.messages),
    ...(tool && !official ? { tools: claudeTools([{ type: 'function', function: tool }]) } : {}),
    ...(tool && official ? { output_config: { ...effort, format: { type: 'json_schema', schema: claudeSchema(tool.parameters) } } }
      : Object.keys(effort).length ? { output_config: effort } : {}),
  };
}

/** 依次拼起各段文字。被拒绝后换模型续写的那段直接接在后面，不另起一段 */
function joinText(content: ClaudeBlock[]) {
  let text = '';
  let continued = false;
  for (const block of content) {
    if (block?.type === 'fallback') continued = true;
    if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text) continue;
    text += (text && !continued ? '\n\n' : '') + block.text;
    continued = false;
  }
  return text;
}

export function claudeReply(body: unknown): AgentMessage {
  const message = body as { content?: ClaudeBlock[]; stop_reason?: string | null } | null;
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) throw new Error('模型响应格式无效，需要支持 Anthropic Messages API 的服务');
  if (message.stop_reason === 'refusal') throw new RefusalError('模型拒绝回答这个问题，可以换个说法再问');
  if (message.stop_reason === 'max_tokens') throw new Error('模型生成未完成，请检查服务的输出限制后重试');
  if (message.stop_reason === 'model_context_window_exceeded') throw new ContextTooLongError();
  // 回答被拒、换模型续写时，分界之前只留文字，思考块和工具调用都不能再发回去（官方文档的回传规则）
  const boundary = message.content.findLastIndex((block) => block?.type === 'fallback');
  const kept = message.content.filter((block, index) => block && block.type !== 'fallback' && (index > boundary || block.type === 'text'));
  const calls: ToolCall[] = kept.filter((block) => block.type === 'tool_use').map((block) => {
    if (typeof block.id !== 'string' || typeof block.name !== 'string') throw new Error('模型返回了无效的工具调用');
    return { id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } };
  });
  const text = joinText(message.content);
  return { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), claudeContent: kept };
}

/** input_tokens 只是没走缓存的部分，三项加起来才是全部输入 */
export function claudeUsage(usage: unknown): ModelUsage {
  const value = (usage ?? {}) as Record<string, number | undefined>;
  const read = value.cache_read_input_tokens ?? 0;
  const write = value.cache_creation_input_tokens ?? 0;
  return { inputTokens: (value.input_tokens ?? 0) + read + write, outputTokens: value.output_tokens ?? 0, cachedTokens: read, cacheWriteTokens: write };
}

interface StreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: Record<string, unknown> };
  content_block?: ClaudeBlock;
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string | null };
  usage?: Record<string, unknown>;
  error?: { message?: string };
}

export async function readClaudeStream(response: Response, startedAt: number, handlers: StreamHandlers): Promise<ModelResult> {
  const content: ClaudeBlock[] = [];
  const inputs = new Map<number, string>();
  let usage: Record<string, unknown> = {};
  let stopReason: string | null = null;
  let firstTokenMs: number | null = null;
  const firstToken = () => { firstTokenMs ??= performance.now() - startedAt; };
  for await (const data of sseData(response)) {
    handlers.onChunk?.();
    let event: StreamEvent;
    try { event = JSON.parse(data); } catch { continue; }
    const index = event.index ?? 0;
    switch (event.type) {
      case 'message_start':
        usage = { ...event.message?.usage };
        break;
      case 'content_block_start': {
        const block = { ...event.content_block } as ClaudeBlock;
        content[index] = block;
        if (block.type === 'tool_use') { inputs.set(index, ''); firstToken(); }
        if (block.type === 'text' && block.text) { firstToken(); handlers.onText(joinText(content)); }
        break;
      }
      case 'content_block_delta': {
        const block = content[index];
        const delta = event.delta;
        if (!block || !delta) break;
        if (delta.type === 'text_delta' && delta.text) {
          block.text = `${block.text ?? ''}${delta.text}`;
          firstToken();
          handlers.onText(joinText(content));
        } else if (delta.type === 'input_json_delta') inputs.set(index, (inputs.get(index) ?? '') + (delta.partial_json ?? ''));
        else if (delta.type === 'thinking_delta') block.thinking = `${block.thinking ?? ''}${delta.thinking ?? ''}`;
        else if (delta.type === 'signature_delta') block.signature = `${block.signature ?? ''}${delta.signature ?? ''}`;
        break;
      }
      case 'content_block_stop': {
        const raw = inputs.get(index);
        if (raw === undefined || !content[index]) break;
        try { content[index].input = raw ? JSON.parse(raw) : {}; }
        catch { throw new Error('模型返回的工具参数不完整，请重试'); }
        break;
      }
      case 'message_delta':
        stopReason = event.delta?.stop_reason ?? stopReason;
        usage = { ...usage, ...event.usage };
        break;
      case 'message_stop':
        return { reply: claudeReply({ content: content.filter(Boolean), stop_reason: stopReason }), usage: claudeUsage(usage), firstTokenMs };
      case 'error':
        throw new Error(event.error?.message ?? '模型返回了错误');
    }
  }
  throw new Error('模型的响应中断了，请重试');
}
