import { endpointFor, modelReply, modelRequest, type ApiType } from '../agent-protocol';
import type { AgentMessage, AgentSettings } from '../agent';
import type { Llm, LlmReply, LlmRequest } from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用插件的模型配置发一次请求。记忆的提取和更新走这里，给了 tool 就强制模型调用它，拿到结构化结果 */
export function modelLlm(settings: AgentSettings, { signal, retries = 1, timeoutMs = 60_000 }: { signal?: AbortSignal; retries?: number; timeoutMs?: number } = {}): Llm {
  const apiType: ApiType = settings.apiType ?? 'responses';
  return {
    async complete(request: LlmRequest): Promise<LlmReply> {
      const messages: AgentMessage[] = request.messages;
      const tools = request.tool ? [{ type: 'function', function: {
        name: request.tool.name, description: request.tool.description, parameters: request.tool.parameters,
      } }] : [];
      const body: Record<string, unknown> = modelRequest(settings, messages, request.system ?? '', tools);
      if (!request.tool) {
        delete body.tools;
        delete body.tool_choice;
      } else if (apiType === 'chat-completions') body.tool_choice = { type: 'function', function: { name: request.tool.name } };
      else body.tool_choice = { type: 'function', name: request.tool.name };
      if (!request.system) {
        if (apiType === 'chat-completions') body.messages = messages;
        else delete body.instructions;
      }
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(endpointFor(settings.baseUrl, apiType), {
          method: 'POST', credentials: 'omit', redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        }).catch((error: unknown) => {
          signal?.throwIfAborted();
          if (attempt >= retries) throw error;
          return null;
        });
        if (response?.ok) {
          const data = await response.json() as { usage?: Record<string, number> };
          const reply = modelReply(data, apiType);
          return {
            text: reply.content ?? '',
            toolArguments: reply.tool_calls?.[0]?.function.arguments ?? null,
            inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0,
          };
        }
        if (response && response.status !== 429 && response.status < 500) throw new Error(`模型请求失败（HTTP ${response.status}）`);
        if (attempt >= retries) throw new Error(`模型请求失败（HTTP ${response?.status ?? '网络错误'}）`);
        await sleep(2000 * 2 ** attempt);
      }
    },
  };
}
