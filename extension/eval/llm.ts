import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ApiType } from '../entrypoints/lib/agent-protocol';
import { modelLlm } from '../entrypoints/lib/memory/model-llm';
import type { Llm, LlmReply, LlmRequest } from '../entrypoints/lib/memory/types';

/** 按用途累计调用次数和 token，消融实验的成本数字从这里来 */
export class UsageMeter implements Llm {
  readonly byPurpose = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
  constructor(private readonly inner: Llm) {}
  async complete(request: LlmRequest) {
    const reply = await this.inner.complete(request);
    const entry = this.byPurpose.get(request.purpose) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    entry.calls += 1;
    entry.inputTokens += reply.inputTokens;
    entry.outputTokens += reply.outputTokens;
    this.byPurpose.set(request.purpose, entry);
    return reply;
  }
  total() {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const entry of this.byPurpose.values()) {
      inputTokens += entry.inputTokens;
      outputTokens += entry.outputTokens;
    }
    return { inputTokens, outputTokens };
  }
}

/**
 * 模型响应按请求内容缓存成 JSONL：重跑不花钱，结果能复现。
 * inner 为空时只回放，缓存里没有就报错，CI 用这个模式。
 */
export class CachedLlm implements Llm {
  private readonly cache = new Map<string, LlmReply>();
  constructor(private readonly inner: Llm | null, private readonly file: string, private readonly model: string) {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { key: string; reply: LlmReply };
      this.cache.set(entry.key, entry.reply);
    }
  }
  async complete(request: LlmRequest) {
    const { purpose: _purpose, ...content } = request;
    const key = createHash('sha256').update(JSON.stringify({ model: this.model, ...content })).digest('hex');
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (!this.inner) throw new Error(`缓存里没有这次请求（${request.purpose}），只回放模式下不能调用模型`);
    const reply = await this.inner.complete(request);
    this.cache.set(key, reply);
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ key, purpose: request.purpose, model: this.model, reply })}\n`);
    return reply;
  }
}

/** 单元测试用：按顺序回放写好的回复，或者用函数按请求生成 */
export class ScriptedLlm implements Llm {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: string[] | ((request: LlmRequest) => string)) {}
  async complete(request: LlmRequest): Promise<LlmReply> {
    this.requests.push(request);
    let text: string;
    if (typeof this.script === 'function') text = this.script(request);
    else {
      const next = this.script.shift();
      if (next === undefined) throw new Error(`脚本回复用完了（${request.purpose}）`);
      text = next;
    }
    return { text, toolArguments: request.tool ? text : null, inputTokens: JSON.stringify(request).length, outputTokens: text.length };
  }
}

/** 从环境变量建模型客户端。没配置时只回放缓存。密钥只从环境变量读，不进代码、缓存和结果文件 */
export function llmFromEnv(cacheFile: string, prefix = 'EVAL'): Llm {
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  const model = process.env[`${prefix}_MODEL`] ?? 'replay';
  const apiType = (process.env[`${prefix}_API_TYPE`] ?? 'chat-completions') as ApiType;
  // 走插件同一套协议层，评测和线上是同一份请求和解析代码
  const inner = baseUrl && apiKey ? modelLlm({ baseUrl, apiKey, model, apiType }, { retries: 5, timeoutMs: 180_000 }) : null;
  return new CachedLlm(inner, cacheFile, `${model}|${apiType}`);
}
