import type { AgentMessage, AgentSettings, ToolCall } from './agent';

export type ApiType = 'responses' | 'chat-completions';
export interface ResponseItem { type: string; [key: string]: unknown }
interface FunctionTool {
  type: string;
  function: { name: string; description: string; parameters: object };
}

export function modelRequest(settings: AgentSettings, messages: AgentMessage[], instructions: string, tools: FunctionTool[]) {
  if (settings.apiType === 'chat-completions') {
    return {
      model: settings.model, stream: false, tools, tool_choice: 'auto',
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
    tool_choice: 'auto', stream: false, store: false, include: ['reasoning.encrypted_content'],
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
