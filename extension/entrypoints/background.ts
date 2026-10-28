import { ApiError, getProgress, postAttempt, putAttemptNote } from './lib/api';
import { leetcodeSiteOf, type LeetCodeSite } from './lib/leetcode';
import { IDLE_MINUTES, MAX_BEAT_GAP_MS, type PauseReason, type TimerStatus } from './lib/timing';

/**
 * 计时状态：**按题目**保存，只累计「页面可见且人在做题」的时间。
 * - 可见：content script 在页面可见时每 BEAT_INTERVAL_MS 发一次心跳，只累加间隔不超过
 *   MAX_BEAT_GAP_MS 的相邻心跳之差。
 * - 在做题：心跳带上页面最近一次操作的时间（键鼠、滚轮、切回页面），侧边栏里的操作也算。
 *   上次操作之后的可见时间先记在 pendingMs：再有操作就并入 committedMs；连续 IDLE_MINUTES
 *   没有操作，就整段丢弃并暂停，回来后任何操作从那一刻接着计。打开题目页后一直没操作，同样作废。
 * - 手动暂停、提交通过后停止：只有在编辑器里打字或在侧边栏点继续才恢复。
 * - 提交（无论结果）后清零；通过的话同时停止，未通过则马上开始下一次。
 */
type TimerState = {
  slug: string;
  committedMs: number;
  pendingMs: number;
  lastBeatAt: number;
  lastActiveAt: number;
  paused: PauseReason | null;
  pausedAt: number;
};
type Timers = Record<string, TimerState>;
type Activity = { activeAt?: number; typedAt?: number };

const MAX_TRACKED_SLUGS = 50;
const MAX_TIME_MS = 86_400_000;
const IDLE_MS = IDLE_MINUTES * 60_000;

const freshTimer = (slug: string, now: number, paused: PauseReason | null = null): TimerState => ({
  slug, committedMs: 0, pendingMs: 0, lastBeatAt: now, lastActiveAt: now, paused, pausedAt: paused ? now : 0,
});

function advance(t: TimerState, now: number, input: Activity) {
  const gap = now - t.lastBeatAt;
  t.lastBeatAt = now;
  const activeAt = Math.min(Number(input.activeAt) || 0, now);
  const typedAt = Math.min(Number(input.typedAt) || 0, now);
  if (t.paused === 'manual' || t.paused === 'done') {
    if (typedAt > t.pausedAt) Object.assign(t, { paused: null, pausedAt: 0, pendingMs: 0, lastActiveAt: typedAt });
    return;
  }
  if (t.paused === null) {
    if (gap > 0 && gap <= MAX_BEAT_GAP_MS) t.pendingMs += gap;
    if (t.pendingMs > IDLE_MS) {
      t.pendingMs = 0;
      t.paused = 'idle';
    }
  }
  if (activeAt > t.lastActiveAt) {
    t.lastActiveAt = activeAt;
    if (t.paused === 'idle') t.paused = null;
    else t.committedMs += t.pendingMs;
    t.pendingMs = 0;
  }
}

function statusOf(t: TimerState | undefined, slug: string, now: number): TimerStatus {
  if (!t) return { slug, elapsedMs: 0, paused: null };
  if (t.paused) return { slug, elapsedMs: Math.min(t.committedMs, MAX_TIME_MS), paused: t.paused };
  const tail = now - t.lastBeatAt;
  const pending = t.pendingMs + (tail > 0 && tail <= MAX_BEAT_GAP_MS ? tail : 0);
  if (pending > IDLE_MS) return { slug, elapsedMs: Math.min(t.committedMs, MAX_TIME_MS), paused: 'idle' };
  return { slug, elapsedMs: Math.min(t.committedMs + pending, MAX_TIME_MS), paused: null };
}

const errText = (e: unknown) =>
  e instanceof ApiError && e.status === 401
    ? '未登录'
    : e instanceof Error
      ? e.message
      : String(e);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function postAttemptWithRetry(input: Parameters<typeof postAttempt>[0]) {
  const delays = [0, 750, 2_000];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) await wait(delay);
    try {
      return await postAttempt(input);
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) throw error;
    }
  }
  throw lastError;
}

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.error('setPanelBehavior failed:', err);
  });

  const getTimers = async (): Promise<Timers> =>
    ((await chrome.storage.session.get('timers')).timers as Timers | undefined) ?? {};

  const saveTimers = async (timers: Timers): Promise<void> => {
    const entries = Object.entries(timers);
    if (entries.length > MAX_TRACKED_SLUGS) {
      entries.sort((a, b) => b[1].lastBeatAt - a[1].lastBeatAt);
      timers = Object.fromEntries(entries.slice(0, MAX_TRACKED_SLUGS));
    }
    await chrome.storage.session.set({ timers });
  };

  // 心跳、侧边栏操作和提交可能同时到达：串行读改写，避免互相覆盖
  let timerQueue: Promise<unknown> = Promise.resolve();
  const updateTimers = <T>(work: (timers: Timers, now: number) => T): Promise<T> => {
    const run = timerQueue.then(async () => {
      const timers = await getTimers();
      const result = work(timers, Date.now());
      await saveTimers(timers);
      return result;
    });
    timerQueue = run.catch(() => {});
    return run;
  };

  const broadcast = (msg: Record<string, unknown>) => {
    void chrome.runtime.sendMessage(msg).catch(() => {});
  };

  const track = (slug: string, input: Activity) =>
    updateTimers((timers, now) => {
      const isNew = !timers[slug];
      const t = (timers[slug] ??= freshTimer(slug, now));
      const before = t.paused;
      advance(t, now, input);
      if (t.paused !== before) broadcast({ type: 'TIMER_STATE', ...statusOf(t, slug, now) });
      return isNew;
    });
  // 键为「站点:提交 id」：国内版、国际版的提交 id 各自编号，会撞号
  const reportingSubmissions = new Map<
    string,
    ReturnType<typeof postAttemptWithRetry>
  >();
  const submissionKey = (site: LeetCodeSite, submissionId?: string) =>
    submissionId ? `${site}:${submissionId}` : undefined;

  const resolveAttemptId = async (site: LeetCodeSite, slug: string, submissionId?: string): Promise<number | null> => {
    const delays = submissionId ? [0, 100, 300, 700, 1_500] : [0];
    const key = submissionKey(site, submissionId);
    for (const delay of delays) {
      if (delay > 0) await wait(delay);
      const pending = key ? reportingSubmissions.get(key) : undefined;
      if (pending) return (await pending).attempt.id;

      const last = (await chrome.storage.session.get('lastAttempt')).lastAttempt as
        | { site: string; slug: string; id: number; submissionId?: string | null }
        | undefined;
      if (
        last?.site === site &&
        last.slug === slug &&
        (!submissionId || last.submissionId === submissionId)
      ) {
        return last.id;
      }

      const progress = await getProgress(slug);
      const matched = submissionId
        ? progress.attempts.find((attempt) => attempt.site === site && attempt.submissionId === submissionId)
        : progress.attempts[0];
      if (matched) return matched.id;
    }
    return null;
  };

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as {
      type?: string;
      slug?: string;
      result?: string;
      verdict?: string;
      title?: string;
      difficulty?: string;
      language?: string;
      note?: string;
      submissionId?: string;
      activeAt?: number;
      typedAt?: number;
      action?: string;
    };
    const type = msg?.type;

    if (type === 'GET_PROBLEM_INFO') {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab?.id == null) {
          sendResponse({ ok: false, error: 'no active tab' });
          return;
        }
        const tabId = tab.id;
        if (!leetcodeSiteOf(tab.url)) {
          sendResponse({
            ok: true,
            isProblemPage: false,
            url: tab.url ?? '',
            slug: null,
            title: null,
            translatedTitle: null,
            difficulty: null,
            difficultyCn: null,
            questionId: null,
            source: 'url',
          });
          return;
        }
        chrome.tabs.sendMessage(tabId, msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            sendResponse({ ok: false, error: err.message });
          } else {
            sendResponse(res ?? { ok: false, error: 'content script did not respond' });
          }
        });
      });
      return true;
    }

    if (type === 'GET_TIMER') {
      void (async () => {
        const slug = msg.slug;
        if (!slug) {
          sendResponse({ ok: true, slug: null, elapsedMs: 0, paused: null });
          return;
        }
        sendResponse({ ok: true, ...statusOf((await getTimers())[slug], slug, Date.now()) });
      })();
      return true;
    }

    if (type === 'PROBLEM_SEEN') {
      void (async () => {
        if (!msg.slug) return;
        const isNew = await track(msg.slug, msg);
        if (isNew) broadcast({ type: 'PROBLEM_CHANGED', slug: msg.slug });
      })();
      return;
    }

    if (type === 'PROBLEM_BEAT') {
      if (msg.slug) void track(msg.slug, msg);
      return;
    }

    if (type === 'PANEL_ACTIVITY') {
      if (msg.slug) void track(msg.slug, { activeAt: Date.now() });
      return;
    }

    if (type === 'TIMER_CONTROL') {
      void (async () => {
        const { slug, action } = msg;
        if (!slug || (action !== 'pause' && action !== 'resume' && action !== 'restart')) {
          sendResponse({ ok: false, error: 'bad payload' });
          return;
        }
        const status = await updateTimers((timers, now) => {
          const t = (timers[slug] ??= freshTimer(slug, now));
          if (action === 'pause') {
            advance(t, now, { activeAt: now });
            if (t.paused !== 'done') Object.assign(t, { paused: 'manual', pausedAt: now });
          } else if (action === 'resume') {
            Object.assign(t, { paused: null, pausedAt: 0, pendingMs: 0, lastActiveAt: now, lastBeatAt: now });
          } else {
            timers[slug] = freshTimer(slug, now);
          }
          return statusOf(timers[slug], slug, now);
        });
        sendResponse({ ok: true, ...status });
        broadcast({ type: 'TIMER_STATE', ...status });
      })();
      return true;
    }

    if (type === 'SUBMISSION_RESULT') {
      void (async () => {
        const { slug, result, verdict, title, difficulty, language, submissionId } = msg;
        // 站点看发消息的标签页地址（Chrome 填的），不信消息内容
        const site = leetcodeSiteOf(sender.url);
        if (!site || !slug || (result !== 'pass' && result !== 'fail')) {
          sendResponse({ ok: false, error: 'bad payload' });
          return;
        }
        const key = submissionKey(site, submissionId);
        if (key) {
          const seen =
            ((await chrome.storage.session.get('seenSubs')).seenSubs as
              | Record<string, true>
              | undefined) ?? {};
          if (seen[key]) {
            sendResponse({ ok: true, duplicate: true });
            return;
          }
        }
        const timeMs = await updateTimers((timers, now) => {
          const t = (timers[slug] ??= freshTimer(slug, now));
          advance(t, now, { activeAt: now });
          return statusOf(t, slug, now).elapsedMs;
        });
        try {
          const existingRequest = key ? reportingSubmissions.get(key) : undefined;
          const request = existingRequest ??
            postAttemptWithRetry({ site, slug, result, verdict, timeMs, language, submissionId, title, difficulty });
          if (key && !existingRequest) reportingSubmissions.set(key, request);

          const { attempt } = await request;
          if (existingRequest) {
            sendResponse({ ok: true, duplicate: true });
            return;
          }
          if (key) {
            const seen =
              ((await chrome.storage.session.get('seenSubs')).seenSubs as
                | Record<string, true>
                | undefined) ?? {};
            seen[key] = true;
            await chrome.storage.session.set({ seenSubs: seen });
          }
          await chrome.storage.session.set({
            lastAttempt: { site, slug: attempt.slug, id: attempt.id, submissionId: attempt.submissionId },
          });
          const status = await updateTimers((timers, now) => {
            timers[slug] = freshTimer(slug, now, result === 'pass' ? 'done' : null);
            return statusOf(timers[slug], slug, now);
          });
          sendResponse({ ok: true, timeMs });
          broadcast({ type: 'ATTEMPT_REPORTED', slug, result });
          broadcast({ type: 'TIMER_STATE', ...status });
        } catch (e) {
          sendResponse({ ok: false, error: errText(e) });
        } finally {
          if (key) reportingSubmissions.delete(key);
        }
      })();
      return true;
    }

    if (type === 'NOTE_SAVE') {
      void (async () => {
        const { slug, note, submissionId } = msg;
        const site = leetcodeSiteOf(sender.url);
        if (!site || !slug || typeof note !== 'string' || !note.trim()) {
          sendResponse({ ok: false, error: 'bad payload' });
          return;
        }
        try {
          const id = await resolveAttemptId(site, slug, submissionId);
          if (id == null) {
            sendResponse({ ok: false, error: '未找到本次作答' });
            return;
          }
          await putAttemptNote(id, note.trim());
          sendResponse({ ok: true });
          broadcast({ type: 'NOTE_SAVED', slug });
        } catch (e) {
          sendResponse({ ok: false, error: errText(e) });
        }
      })();
      return true;
    }

    return;
  });
});
