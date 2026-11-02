import type { LeetCodeSite } from './leetcode';

// 自建部署改这里（同时要改 wxt.config.ts 的 host_permissions）
export const SITE_URL = 'https://acbuddy.pages.dev';

export interface Me {
  user: { id: number; username: string };
}

export interface Progress {
  platform: string;
  slug: string;
  title: string | null;
  difficulty: string | null;
  done: boolean;
  mastery: number;
  urgency: number;
  tags: string[];
  note: string;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  totalTimeMs: number;
  attemptCount: number;
  lastResult: 'pass' | 'fail' | null;
}

export interface Attempt {
  id: number;
  platform: string;
  slug: string;
  site: string;
  result: 'pass' | 'fail';
  verdict: string | null;
  timeMs: number | null;
  language: string | null;
  submissionId: string | null;
  note: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: `/api${string}`, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SITE_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: T; error?: string }
    | null;
  if (!res.ok || body?.ok !== true) {
    throw new ApiError(body?.error ?? `HTTP ${res.status}`, res.status);
  }
  return body.data as T;
}

export async function getMe(): Promise<Me | null> {
  try {
    return await call<Me>('/api/auth/me');
  } catch {
    return null;
  }
}

/** 和 getMe 不同，失败时抛错：同步要分清「没登录」（401）和「网络不通」 */
export const currentUser = () => call<Me>('/api/auth/me');

/** 跟随账号同步的记忆。只有记忆本身，没有对话，也没有记忆引用的用户原话 */
export interface MemoryUpload {
  id: string;
  type: 'semantic' | 'episodic' | 'procedural';
  text: string;
  concepts: string[];
  problemKey: string | null;
  importance: number;
  attemptIds: number[];
  sources: string[];
  validFrom: number;
  invalidAt: number | null;
  createdAt: number;
  supersededBy: string | null;
}
export interface RemoteMemory extends MemoryUpload {
  updatedAt: number;
  deleted: boolean;
}
export const pullMemories = (since: number, after: string) =>
  call<{ memories: RemoteMemory[]; more: boolean }>(`/api/memories?since=${since}&after=${encodeURIComponent(after)}`);
export const pushMemories = (put: MemoryUpload[], remove: string[]) =>
  call<{ updatedAt: number }>('/api/memories/sync', { method: 'POST', body: JSON.stringify({ put, remove }) });
export const clearRemoteMemories = () => call<{ clearedAt: number }>('/api/memories', { method: 'DELETE' });

export const getProgress = (slug: string, signal?: AbortSignal) =>
  call<{ progress: Progress | null; attempts: Attempt[] }>(
    `/api/progress/leetcode/${encodeURIComponent(slug)}`,
    { signal },
  );

export const postAttempt = (input: {
  site: LeetCodeSite;
  slug: string;
  result: 'pass' | 'fail';
  verdict?: string;
  timeMs: number;
  language?: string;
  submissionId?: string;
  title?: string;
  difficulty?: string;
  note?: string;
}) => call<{ progress: Progress; attempt: Attempt; duplicate: boolean }>('/api/attempts', {
  method: 'POST',
  body: JSON.stringify(input),
});

export const putAttemptNote = (id: number, note: string) =>
  call<{ attempt: Attempt }>(`/api/attempts/${id}`, { method: 'PUT', body: JSON.stringify({ note }) });

// 当前窗口里已经开着网站就切过去，不再新开标签页
export async function openSite() {
  const [tab] = await chrome.tabs.query({ url: `${SITE_URL}/*`, currentWindow: true });
  if (tab?.id != null) await chrome.tabs.update(tab.id, { active: true });
  else await chrome.tabs.create({ url: SITE_URL });
}
