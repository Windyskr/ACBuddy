import type { ProblemInfo } from './content';
import { ApiError, getProgress, postAttempt, putAttemptNote } from './lib/api';
import { leetcodeSiteOf, type LeetCodeSite } from './lib/leetcode';
import { pageReaders, type PageReadResult } from './lib/page-readers';
import { difficultyOf, problemOf, type ProblemHeader, type ProblemRef } from './lib/platforms';
import {
  DISPLAY_KEY, FLOAT_LAYOUT_KEY, FLOAT_MIN_HEIGHT, FLOAT_MIN_WIDTH, FLOAT_MODE, FLOAT_OPEN, FLOAT_SAVE, FLOAT_SHOW, FLOAT_SITES,
  FLOAT_STATE, FLOAT_TOGGLE, type DisplayMode, type FloatLayout, type FloatLayouts,
} from './lib/display';
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

/** 顶栏要的题号、标题、难度：力扣问内容脚本，其他平台在页面里读 */
async function readHeader(tabId: number, problem: ProblemRef): Promise<ProblemHeader> {
  if (problem.platform === 'leetcode') {
    const info = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROBLEM_INFO' }) as (ProblemInfo & { ok?: boolean }) | undefined;
    if (!info?.ok) throw new Error('content script did not respond');
    return {
      ...problem, number: info.questionId,
      title: info.translatedTitle || info.title || problem.id,
      difficulty: difficultyOf('leetcode', info.difficultyCn),
    };
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: pageReaders[problem.platform], args: [problem.id],
  });
  const result = injection?.result as PageReadResult | undefined;
  if (result && 'problem' in result) {
    const { number, title, difficulty } = result.problem;
    return { ...problem, number, title: title || problem.id, difficulty: difficultyOf(problem.platform, difficulty) };
  }
  if (!result || result.retry) throw new Error(result?.error ?? '读取题目失败');
  return { ...problem, number: null, title: problem.id, difficulty: null };
}

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

/** 发给悬浮窗的内容脚本；插件装好之前就开着的标签页没有它，补注入一次再发 */
async function sendToFloat(tabId: number, type: string) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/float.js'] });
    return chrome.tabs.sendMessage(tabId, { type });
  }
}

const displayMode = async (): Promise<DisplayMode> =>
  ((await chrome.storage.local.get(DISPLAY_KEY))[DISPLAY_KEY] === 'float' ? 'float' : 'sidepanel');

/** 内容脚本发来的位置只接受像样的数字，存到发消息的那个网站名下 */
function validLayout(value: unknown): FloatLayout | null {
  const layout = value as Partial<FloatLayout> | null;
  const numbers = ['right', 'top', 'width', 'height', 'bubbleRight', 'bubbleTop'] as const;
  if (!layout || typeof layout.open !== 'boolean' || numbers.some((key) => !Number.isFinite(layout[key]) || Math.abs(layout[key]!) > 100_000)) return null;
  if (layout.width! < FLOAT_MIN_WIDTH || layout.height! < FLOAT_MIN_HEIGHT) return null;
  const { right, top, width, height, bubbleRight, bubbleTop, open } = layout as FloatLayout;
  return { right, top, width, height, bubbleRight, bubbleTop, open };
}

export default defineBackground(() => {
  // 侧边栏模式：点工具栏图标打开侧边栏。悬浮窗模式：自己处理点击，在题目页上显示或收起悬浮窗
  const applyDisplay = (mode: DisplayMode) => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: mode !== 'float' }).catch((err) => {
      console.error('setPanelBehavior failed:', err);
    });
  };
  void displayMode().then(applyDisplay);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(DISPLAY_KEY in changes)) return;
    const mode: DisplayMode = changes[DISPLAY_KEY]!.newValue === 'float' ? 'float' : 'sidepanel';
    applyDisplay(mode);
    // 开着的题目页跟着换：悬浮窗模式出现圆钮，侧边栏模式拿掉悬浮窗
    void chrome.tabs.query({ url: [...FLOAT_SITES] }).then((tabs) => {
      for (const tab of tabs) if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: FLOAT_MODE, mode }).catch(() => {});
    });
  });
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id == null) return;
    // 别的网页上没有悬浮窗，照常打开侧边栏（要在点击的同一刻调用，不能先等别的）
    if (!problemOf(tab.url)) {
      void chrome.sidePanel.open({ tabId: tab.id }).catch((err) => console.error('sidePanel.open failed:', err));
      return;
    }
    void sendToFloat(tab.id, FLOAT_TOGGLE).catch((err) => console.error('float toggle failed:', err));
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

    // 悬浮窗：内容脚本读不到 chrome.storage.local，模式和这个网站的位置由后台转
    if (type === FLOAT_STATE || type === FLOAT_SAVE) {
      const host = sender.url ? new URL(sender.url).hostname : '';
      if (!sender.tab || !host) return;
      void (async () => {
        const layouts = ((await chrome.storage.local.get(FLOAT_LAYOUT_KEY))[FLOAT_LAYOUT_KEY] as FloatLayouts | undefined) ?? {};
        if (type === FLOAT_STATE) {
          sendResponse({ mode: await displayMode(), layout: validLayout(layouts[host]) });
          return;
        }
        const layout = validLayout((raw as { layout?: unknown }).layout);
        if (layout) await chrome.storage.local.set({ [FLOAT_LAYOUT_KEY]: { ...layouts, [host]: layout } });
        sendResponse({ ok: !!layout });
      })();
      return true;
    }
    // 只有插件自己的页面（侧边栏、悬浮窗里的面板）能指定标签页
    const fromExtension = !!sender.url?.startsWith(chrome.runtime.getURL(''));
    // 侧边栏改成悬浮窗时，在当前题目页上把悬浮窗打开
    if (type === FLOAT_SHOW) {
      const tabId = fromExtension ? (raw as { tabId?: unknown }).tabId : undefined;
      if (typeof tabId === 'number') void sendToFloat(tabId, FLOAT_OPEN).catch((err) => console.error('float open failed:', err));
      return;
    }

    if (type === 'GET_PROBLEM_INFO') {
      void (async () => {
        // 悬浮窗看它自己所在的标签页，侧边栏看最近聚焦的窗口里的活动标签页
        const tabId = fromExtension ? (raw as { tabId?: unknown }).tabId : undefined;
        const [tab] = typeof tabId === 'number'
          ? [await chrome.tabs.get(tabId).catch(() => undefined)]
          : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id == null) {
          sendResponse({ ok: false, error: 'no active tab' });
          return;
        }
        const problem = problemOf(tab.url);
        if (!problem) {
          sendResponse({ ok: true, problem: null });
          return;
        }
        try {
          sendResponse({ ok: true, problem: await readHeader(tab.id, problem) });
        } catch (e) {
          sendResponse({ ok: false, error: errText(e) });
        }
      })();
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
