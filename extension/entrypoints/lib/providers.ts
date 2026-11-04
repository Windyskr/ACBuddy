import type { AgentSettings } from './agent';
import type { ApiType } from './agent-protocol';
import { hostOf } from './protocol-common';

/** 适配过的服务。按 API 地址的域名认，用户自己填的地址也一样适配 */
export type Vendor = 'deepseek' | 'openai' | 'anthropic' | 'openrouter';

const HOSTS: Record<string, Vendor> = {
  'api.deepseek.com': 'deepseek',
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'openrouter.ai': 'openrouter',
};
export const vendorOf = (baseUrl: string): Vendor | null => HOSTS[hostOf(baseUrl)] ?? null;

/**
 * 按用户填的地址判断用哪种接口：地址写到了 /responses、/chat/completions、/messages 就按它；
 * DeepSeek 的 Claude 兼容地址（…/anthropic）按 Anthropic Messages；四家官方地址按各家的接口；
 * 其余按 Chat Completions，中转站和本地服务大多兼容它
 */
export function apiTypeOfUrl(baseUrl: string): ApiType {
  let path: string;
  try { path = new URL(baseUrl.trim()).pathname.replace(/\/+$/, ''); } catch { return 'chat-completions'; }
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/chat/completions')) return 'chat-completions';
  if (path.endsWith('/messages') || /\/anthropic(?:\/|$)/.test(path)) return 'anthropic';
  return PROVIDERS.find((provider) => provider.id === vendorOf(baseUrl))?.apiType ?? 'chat-completions';
}

export interface ModelPreset { id: string; label: string }
export interface ProviderPreset {
  id: Vendor;
  label: string;
  baseUrl: string;
  apiType: ApiType;
  /** 推荐的模型，第一个是默认 */
  models: ModelPreset[];
}

export const PROVIDERS: ProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiType: 'chat-completions', models: [
    { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
  ] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiType: 'responses', models: [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  ] },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiType: 'anthropic', models: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  ] },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiType: 'chat-completions', models: [
    { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
    { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
  ] },
];

/**
 * OpenRouter 的模型名以厂商开头，不同厂商的缓存、推理和强制调用工具的规矩不一样。
 * 别名前面多一个 ~，比如 ~anthropic/claude-sonnet-latest
 */
export const routedVendor = (model: string) => {
  const prefix = model.trim().replace(/^~/, '').split('/')[0];
  return prefix === 'anthropic' || prefix === 'openai' || prefix === 'deepseek' ? prefix : null;
};

const MINUTE = 60_000;
/**
 * 服务端的提示缓存大约能留多久。距上次回答超过这个时间，裁旧工具结果不会多花钱（见 context.ts 的 trimHistory）。
 * 不认识的服务返回 undefined，按 context.ts 的 CACHE_COLD_MS 算。
 * - Claude 官方接口：插件标的是 1 小时缓存；别的 Claude 兼容服务按默认的 5 分钟标。
 * - OpenAI：GPT-5.6 默认保留 30 分钟。
 * - DeepSeek：文档说不用之后「通常几小时到几天」清掉，按 3 小时算。
 * - OpenRouter：同一段对话固定发给同一家服务商，闲置 10 分钟后就不固定了，可能换一家、缓存跟着没了；
 *   经它调 Claude 用 5 分钟的缓存，因为换了服务商，1 小时缓存多付的写入钱就白花了。
 */
export function cacheLifetimeMs(settings: AgentSettings): number | undefined {
  const vendor = vendorOf(settings.baseUrl);
  if (vendor === 'openrouter') return routedVendor(settings.model) === 'anthropic' ? 5 * MINUTE : 10 * MINUTE;
  if (vendor === 'openai') return 30 * MINUTE;
  if (vendor === 'deepseek') return 180 * MINUTE;
  if (vendor === 'anthropic') return 60 * MINUTE;
  if (apiTypeOfUrl(settings.baseUrl) === 'anthropic') return 5 * MINUTE;
  return undefined;
}

/** GPT-5.6 起才有 prompt_cache_options，发给更早的模型会报错 */
export const hasCacheOptions = (model: string) => /^~?(?:openai\/)?gpt-(?:5\.(?:[6-9]|\d{2,})|[6-9])/.test(model);
