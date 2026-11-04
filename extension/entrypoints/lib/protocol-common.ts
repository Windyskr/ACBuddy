import type { AgentMessage } from './agent';

export interface ModelUsage {
  /** 这次请求的全部输入，含命中缓存和写入缓存的部分 */
  inputTokens: number;
  outputTokens: number;
  /** 命中提示缓存的输入 token，服务不报告时为 0 */
  cachedTokens: number;
  /** 写入缓存的输入 token，只有 Claude 单独计价并报告 */
  cacheWriteTokens?: number;
}

export interface ModelResult {
  reply: AgentMessage;
  usage: ModelUsage;
  /** 从发出请求到第一个文字或工具调用片段的毫秒数，非流式响应为 null */
  firstTokenMs: number | null;
}

export interface StreamHandlers {
  /** 当前这一步到目前为止的全部文字 */
  onText(text: string): void;
  /** 每收到一块数据调用一次，用来重置空闲超时 */
  onChunk?(): void;
}

/** 模型报告上下文超长：HTTP 错误或者 Claude 的 model_context_window_exceeded */
export class ContextTooLongError extends Error {}
/** 模型拒绝回答。半路被拒时已经生成的文字不算数，不能留在对话里 */
export class RefusalError extends Error {}

/** 不能强制调用工具时，在提示里要求调用 */
export const toolInstruction = (name: string) => `调用 ${name} 工具给出结果，不要直接回复。`;

export const hostOf = (baseUrl: string) => {
  try { return new URL(baseUrl.trim()).hostname; } catch { return ''; }
};

/** 逐条读 SSE 的 data。网络分块不按行对齐，要自己攒到换行 */
export async function* sseData(response: Response) {
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
