/** 长期记忆的三类（CoALA 的分法）。工作记忆就是当前对话，不进这里 */
export type MemoryType = 'semantic' | 'episodic' | 'procedural';

/** 记忆的证据：用户原话，或一条真实作答记录。题面、代码、工具输出和助手的话都不算 */
export type Evidence =
  | { kind: 'user_quote'; sessionId: string; quote: string }
  | { kind: 'attempt'; attemptId: number };

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  text: string;
  /** 知识点规范名，见 concepts.ts */
  concepts: string[];
  /** 题目键「平台:题号」，只和某道题有关时才有 */
  problemKey: string | null;
  /** 1–5 */
  importance: number;
  evidence: Evidence[];
  /** 由哪些记忆归纳而来，删除时级联 */
  sources: string[];
  /** 事实时间线：事实从何时起成立、何时不再成立 */
  validFrom: number;
  invalidAt: number | null;
  /** 系统时间线：何时写入 */
  createdAt: number;
  /** 取代它的记忆 */
  supersededBy: string | null;
}

export interface LlmRequest {
  /** 用途，用来分项统计费用：extract、reconcile、answer…… */
  purpose: string;
  system?: string;
  messages: { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  /** 给了就强制调用这个工具，结果在 toolArguments */
  tool?: { name: string; description: string; parameters: object };
}
export interface LlmReply {
  text: string;
  toolArguments: string | null;
  inputTokens: number;
  outputTokens: number;
}
export interface Llm {
  complete(request: LlmRequest): Promise<LlmReply>;
}
