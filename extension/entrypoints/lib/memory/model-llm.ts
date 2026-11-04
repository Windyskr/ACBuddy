import { forcesTool, postModel, structuredReply, structuredRequest } from '../agent-protocol';
import type { AgentSettings } from '../agent';
import type { Llm, LlmReply, LlmRequest } from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 用插件的模型配置发一次请求。记忆的提取和更新走这里，给了 tool 就要求模型按它的格式回答，结果在 toolArguments。
 * 各家要结构化结果的办法不一样（强制调用工具、结构化输出），见 structuredRequest
 */
export function modelLlm(settings: AgentSettings, { signal, retries = 1, timeoutMs = 60_000 }: { signal?: AbortSignal; retries?: number; timeoutMs?: number } = {}): Llm {
  return {
    async complete(request: LlmRequest): Promise<LlmReply> {
      let body = structuredRequest(settings, request);
      for (let attempt = 0; ; attempt++) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await postModel(settings, body, signal ? AbortSignal.any([signal, timeout]) : timeout).catch((error: unknown) => {
          signal?.throwIfAborted();
          if (attempt >= retries) throw error;
          return null;
        });
        if (response?.ok) {
          const { text, toolArguments, usage } = structuredReply(settings, await response.json(), request);
          return { text, toolArguments, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        }
        // 不认识的服务里有的不接受强制调用工具（比如思考模式下的推理模型），改成在提示里要求调用，再试一次
        if (response?.status === 400 && forcesTool(body)) {
          body = structuredRequest(settings, request, { force: false });
          attempt--;
          continue;
        }
        if (response && response.status !== 429 && response.status < 500) throw new Error(`模型请求失败（HTTP ${response.status}）`);
        if (attempt >= retries) throw new Error(`模型请求失败（HTTP ${response?.status ?? '网络错误'}）`);
        await sleep(2000 * 2 ** attempt);
      }
    },
  };
}
