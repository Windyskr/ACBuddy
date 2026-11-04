// 推荐模型的真实接口冒烟测试：用插件自己的协议代码（拼请求、流式解析、上下文裁剪、记忆整理）跑一段三轮的辅导对话。
// 页面工具换成固定的假数据，其余和插件里一样。会花一点钱，见 eval/README.md
import { systemPrompt, toolsFor, type AgentMessage, type AgentSettings, type Effort, type ToolCall } from '../../entrypoints/lib/agent';
import { modelRequest, postModel, readModelStream, type ModelUsage } from '../../entrypoints/lib/agent-protocol';
import { capToolResult, requestMessages, trimHistory } from '../../entrypoints/lib/context';
import { extractCandidates } from '../../entrypoints/lib/memory/extract';
import { modelLlm } from '../../entrypoints/lib/memory/model-llm';
import type { ProblemRef } from '../../entrypoints/lib/platforms';
import { PROVIDERS, type Vendor } from '../../entrypoints/lib/providers';

export const KEY_NAMES: Record<Vendor, string> = {
  deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY',
};

const PROBLEM: ProblemRef = { platform: 'leetcode', site: 'leetcode.cn', id: 'two-sum', key: 'leetcode:two-sum', url: 'https://leetcode.cn/problems/two-sum/' };
// 题面写长一点：各家缓存都有最小长度（OpenAI 1024 token），太短测不出命中
const STATEMENT = `当前题目信息
平台：力扣
题目：1. 两数之和（简单）
标签：数组、哈希表
答题模式：核心代码模式，实现 Solution 类的 twoSum 方法

题目描述：
给定一个整数数组 nums 和一个整数目标值 target，请你在该数组中找出和为目标值 target 的那两个整数，并返回它们的数组下标。
你可以假设每种输入只会对应一个答案，并且你不能使用两次相同的元素。你可以按任意顺序返回答案。

示例 1：
输入：nums = [2,7,11,15], target = 9
输出：[0,1]
解释：因为 nums[0] + nums[1] == 9 ，返回 [0, 1] 。

示例 2：
输入：nums = [3,2,4], target = 6
输出：[1,2]

示例 3：
输入：nums = [3,3], target = 6
输出：[0,1]

提示：
2 <= nums.length <= 10^4
-10^9 <= nums[i] <= 10^9
-10^9 <= target <= 10^9
只会存在一个有效答案

进阶：你可以想出一个时间复杂度小于 O(n^2) 的算法吗？

${'补充说明：数组中的元素可能为负数，也可能有重复元素；返回的两个下标必须不同；下标从 0 开始计数；如果有多组解，题目保证只有一组有效答案。'.repeat(12)}`;

const CODE = `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        for (int i = 0; i < nums.size(); i++) {
            seen[nums[i]] = i;
            if (seen.count(target - nums[i])) {
                return {seen[target - nums[i]], i};
            }
        }
        return {};
    }
};`;

/** 页面工具的假结果。代码先存再查，同一个元素会被用两次：[3,2,4] 找 6 时返回 [0,0] */
function fakeTool(call: ToolCall) {
  switch (call.function.name) {
    case 'get_code': return { language: 'cpp', code: CODE.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n'), uri: 'inmemory://model/1' };
    case 'get_judge_result': return { kind: 'submit', status: 'Wrong Answer', passed: 41, total: 63, failedCase: { input: 'nums = [3,2,4], target = 6', expected: '[1,2]', actual: '[0,0]' }, codeChanged: false };
    case 'get_history': return { progress: null, attempts: [] };
    case 'highlight_errors':
    case 'clear_highlights': return { ok: true };
    default: return { error: '未知工具' };
  }
}

interface Step extends ModelUsage { ms: number; tools: string[] }
export interface ProviderOutcome {
  provider: string;
  model: string;
  ok: boolean;
  error?: string;
  /** 每一轮提问调用了几次模型、用了哪些工具 */
  turns: { steps: Step[]; answerChars: number }[];
  /** 第二轮第一次请求命中缓存的 token：前一轮的内容应该都在缓存里 */
  secondTurnCached: number;
  /** 第三轮前强制裁掉旧工具结果（Claude 的思考块跟着作废），之后的请求要照常成功 */
  afterTrimOk: boolean;
  memories: number;
}

async function ask(settings: AgentSettings, messages: AgentMessage[], conversationId: string) {
  const system = systemPrompt(PROBLEM, false);
  const tools = toolsFor(PROBLEM, false);
  const steps: Step[] = [];
  for (let step = 0; step < 6; step++) {
    const started = performance.now();
    const response = await postModel(settings, modelRequest(settings, requestMessages(messages), system, tools, { stream: true, conversationId, effort: settings.effort }), AbortSignal.timeout(180_000));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const { reply, usage } = await readModelStream(response, settings, started, { onText() {} });
    const calls = reply.tool_calls ?? [];
    steps.push({ ...usage, ms: Math.round(performance.now() - started), tools: calls.map((call) => call.function.name) });
    messages.push(reply);
    if (!calls.length) {
      if (!reply.content?.trim()) throw new Error('模型没有返回回答');
      messages.at(-1)!.trace = { model: settings.model, totalMs: 0, endedAt: Date.now(), steps: [], tools: [] };
      return { steps, answerChars: reply.content.length };
    }
    for (const call of calls) messages.push({ role: 'tool', tool_call_id: call.id, content: capToolResult(JSON.stringify(fakeTool(call))) });
  }
  throw new Error('六次调用还没有给出回答');
}

export function runProvider(vendor: Vendor, model: string, apiKey: string, effort?: Effort): Promise<ProviderOutcome> {
  const preset = PROVIDERS.find((item) => item.id === vendor)!;
  return runSettings({ baseUrl: preset.baseUrl, model, apiKey, ...(effort ? { effort } : {}) }, preset.label);
}

/** 按任意配置跑同样的对话，第三方服务也能测 */
export async function runSettings(settings: AgentSettings, provider: string): Promise<ProviderOutcome> {
  const { model, apiKey } = settings;
  const outcome: ProviderOutcome = { provider, model, ok: false, turns: [], secondTurnCached: 0, afterTrimOk: false, memories: 0 };
  const conversationId = `smoke-${Date.now()}`;
  let messages: AgentMessage[] = [{ role: 'user', kind: 'problem', content: STATEMENT }];
  try {
    messages.push({ role: 'user', content: '我提交了没通过，帮我看看代码哪里错了，先别给完整答案。' });
    outcome.turns.push(await ask(settings, messages, conversationId));
    messages.push({ role: 'user', content: '明白了。那这个解法的时间复杂度和空间复杂度是多少？' });
    const second = await ask(settings, messages, conversationId);
    outcome.turns.push(second);
    outcome.secondTurnCached = second.steps[0]?.cachedTokens ?? 0;
    // 不管攒没攒够，把能裁的旧工具结果都裁掉，模拟插件在长对话里的那次裁剪
    messages = trimHistory([...messages, { role: 'user', content: '好的，那我改成先查再存，这样就对了吧？' }], Date.now(), 0);
    outcome.turns.push(await ask(settings, messages, conversationId));
    outcome.afterTrimOk = true;
    const candidates = await extractCandidates(modelLlm(settings, { timeoutMs: 120_000 }), {
      id: conversationId, now: Date.now(), problem: { key: PROBLEM.key, title: '两数之和', tags: ['数组', '哈希表'] },
      turns: [
        { role: 'user', content: '我主要用 Go 写题，最近在准备字节的后端面试，动态规划是我最弱的地方。' },
        { role: 'assistant', content: '好的，之后讲解我会用 Go，并多带你练动态规划。' },
        { role: 'user', content: '讲题的时候先给提示，别直接给完整代码。' },
      ],
    }, { minimizeInput: true });
    outcome.memories = candidates.length;
    outcome.ok = outcome.memories > 0;
    if (!outcome.ok) outcome.error = '记忆整理没有提取到内容';
  } catch (error) {
    // 错误信息里可能带着服务回显的密钥片段，存进结果文件前遮掉
    outcome.error = (error instanceof Error ? error.message : String(error)).replaceAll(apiKey, '***').replace(/\b(sk|or|ds)-[\w-]{6,}/g, '$1-***');
  }
  return outcome;
}

export const presetModels = (vendor: Vendor) => PROVIDERS.find((item) => item.id === vendor)!.models.map((model) => model.id);
