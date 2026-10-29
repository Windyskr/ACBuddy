import { BEAT_INTERVAL_MS } from './lib/timing';

export interface ProblemInfo {
  isProblemPage: boolean;
  url: string;
  slug: string | null;
  title: string | null;
  translatedTitle: string | null;
  difficulty: string | null;
  difficultyCn: string | null;
  questionId: string | null;
  source: 'next-data' | 'dom' | 'url';
}

const PROBLEM_RE = /\/problems\/([a-z0-9-]+)/i;
const CONTEST_PROBLEM_RE = /\/contest\/[^/]+\/problems\/([a-z0-9-]+)/i;
const DIFFICULTY_CN: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
  简单: '简单',
  中等: '中等',
  困难: '困难',
};
const difficultyCn = (raw: string | null): string | null =>
  raw ? (DIFFICULTY_CN[raw.toLowerCase()] ?? DIFFICULTY_CN[raw] ?? null) : null;
const DIFFICULTY_LEVEL: Record<string, string> = { 简单: 'EASY', 中等: 'MEDIUM', 困难: 'HARD' };
const difficultyLevel = (raw: string | null): string | undefined => {
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  return upper === 'EASY' || upper === 'MEDIUM' || upper === 'HARD' ? upper : DIFFICULTY_LEVEL[raw];
};

const slugFromUrl = (pathname: string): string | null =>
  (pathname.match(CONTEST_PROBLEM_RE) ?? pathname.match(PROBLEM_RE))?.[1] ?? null;

function fromNextData(): Partial<ProblemInfo> | null {
  const el = document.getElementById('__NEXT_DATA__');
  if (!el?.textContent) return null;
  let data: unknown;
  try {
    data = JSON.parse(el.textContent);
  } catch {
    return null;
  }
  const candidates: Record<string, unknown>[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 14 || candidates.length > 20) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      typeof obj.difficulty === 'string' &&
      (typeof obj.translatedTitle === 'string' || typeof obj.title === 'string')
    ) {
      candidates.push(obj);
    }
    for (const value of Object.values(obj)) visit(value, depth + 1);
  };
  visit(data, 0);
  const q =
    candidates.find((c) => typeof c.translatedTitle === 'string') ?? candidates[0] ?? null;
  if (!q) return null;
  return {
    title: (q.title as string) ?? null,
    translatedTitle: (q.translatedTitle as string) ?? null,
    difficulty: (q.difficulty as string) ?? null,
    questionId: q.questionId != null ? String(q.questionId) : null,
    source: 'next-data',
  };
}

function fromDom(): Partial<ProblemInfo> {
  const titleEl =
    document.querySelector<HTMLElement>('[data-cy="question-title"]') ??
    document.querySelector<HTMLElement>('h1');
  const diffEl = Array.from(document.querySelectorAll<HTMLElement>('a, span, div, p')).find(
    (el) =>
      el.children.length === 0 && DIFFICULTY_CN[el.textContent?.trim() ?? ''] !== undefined,
  );
  return {
    title: titleEl?.textContent?.trim() ?? null,
    translatedTitle: null,
    difficulty: diffEl?.textContent?.trim() ?? null,
    questionId: null,
    source: 'dom',
  };
}

function extractProblemInfo(): ProblemInfo {
  const url = location.href;
  const slug = slugFromUrl(location.pathname);
  const base: ProblemInfo = {
    isProblemPage: slug != null,
    url,
    slug,
    title: null,
    translatedTitle: null,
    difficulty: null,
    difficultyCn: null,
    questionId: null,
    source: 'url',
  };
  if (base.isProblemPage) {
    const fromNext = fromNextData();
    if (fromNext && (fromNext.title || fromNext.translatedTitle || fromNext.difficulty)) {
      Object.assign(base, fromNext);
    } else {
      Object.assign(base, fromDom());
    }
    base.difficultyCn = difficultyCn(base.difficulty);
  }
  return base;
}

type SubmitDetail = {
  slug: string;
  result: 'pass' | 'fail';
  verdict?: string;
  language?: string;
  submissionId?: string;
};

const fmtMs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

let cardHost: HTMLElement | null = null;
let cardSlug: string | null = null;
let cardAutoClose: number | null = null;
// 同一次提交只弹一张卡：页面判完常会再拉一次 check，提交后地址又会换成 /submissions/<id>/
const shownSubmissions = new Set<string>();
const closeCard = () => {
  if (cardAutoClose != null) {
    window.clearTimeout(cardAutoClose);
    cardAutoClose = null;
  }
  cardHost?.remove();
  cardHost = null;
  cardSlug = null;
};

function showResultCard(d: SubmitDetail) {
  if (d.submissionId) {
    if (shownSubmissions.has(d.submissionId)) return;
    shownSubmissions.add(d.submissionId);
  }
  closeCard();
  cardSlug = d.slug;
  const host = document.createElement('div');
  host.id = 'acb-result-card';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .card { position: fixed; right: 16px; top: 16px; z-index: 2147483647; width: 300px; box-sizing: border-box;
      overflow: hidden; padding: 10px 12px 12px; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff;
      color: #1e293b; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 10px 30px rgba(15, 23, 42, .16); animation: card-in .18s ease-out; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .result { font-size: 14px; font-weight: 600; }
    .result.pass { color: #29731d; }
    .result.fail { color: #e11d48; }
    .brand { color: #94a3b8; font-size: 11px; }
    .close { margin-left: auto; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
      background: transparent; color: #94a3b8; font: 18px/1 system-ui, sans-serif; cursor: pointer; }
    .close:hover { background: #f1f5f9; color: #334155; }
    textarea { display: block; width: 100%; box-sizing: border-box; min-height: 52px; padding: 6px 9px; resize: vertical;
      border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: inherit; font: inherit; }
    textarea::placeholder { color: #94a3b8; }
    textarea:focus { outline: none; border-color: #358614; box-shadow: 0 0 0 3px #cef3aa; }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .status { flex: 1; min-width: 0; color: #64748b; font-size: 12px; }
    .status.error { color: #e11d48; }
    .save { flex: none; padding: 4px 12px; border: 0; border-radius: 6px; background: #358614; color: #fff;
      font: 500 12px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; cursor: pointer; }
    .save:hover { background: #29731d; }
    .save:disabled { opacity: .6; cursor: default; }
    .countdown { position: absolute; left: 0; bottom: 0; width: 100%; height: 2px; transform-origin: left;
      animation: countdown 5s linear forwards; }
    .pass .countdown { background: #5bb924; }
    .fail .countdown { background: #f43f5e; }
    @keyframes countdown { to { transform: scaleX(0); } }
    @keyframes card-in { from { opacity: 0; transform: translateY(-6px); } }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } .countdown { display: none; } }
  `;
  const card = document.createElement('div');
  card.className = `card ${d.result}`;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'ACBuddy 作答记录');
  const head = document.createElement('div');
  head.className = 'head';
  const result = document.createElement('strong');
  result.className = `result ${d.result}`;
  result.textContent = d.result === 'pass' ? '通过 ✓' : '未通过 ✗';
  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = 'ACBuddy';
  const skip = document.createElement('button');
  skip.className = 'close';
  skip.type = 'button';
  skip.textContent = '×';
  skip.title = '跳过（Esc）';
  skip.setAttribute('aria-label', '跳过');
  head.append(result, brand, skip);
  const ta = document.createElement('textarea');
  ta.rows = 2;
  ta.placeholder = '记录思路、卡点或易错点（可选）';
  ta.setAttribute('aria-label', '本次心得');
  const foot = document.createElement('div');
  foot.className = 'foot';
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = '正在记录…';
  const save = document.createElement('button');
  save.className = 'save';
  save.type = 'button';
  save.textContent = '保存心得';
  foot.append(status, save);
  const countdown = document.createElement('div');
  countdown.className = 'countdown';
  card.append(head, ta, foot, countdown);
  shadow.append(style, card);
  document.documentElement.appendChild(host);
  cardHost = host;
  ta.focus();
  const setStatus = (text: string, isError = false) => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };

  cardAutoClose = window.setTimeout(closeCard, 5000);
  const cancelAutoClose = () => {
    if (cardAutoClose != null) {
      window.clearTimeout(cardAutoClose);
      cardAutoClose = null;
    }
    countdown.remove();
    card.removeEventListener('pointerdown', cancelAutoClose);
    card.removeEventListener('keydown', cancelAutoClose);
    card.removeEventListener('input', cancelAutoClose);
  };
  card.addEventListener('pointerdown', cancelAutoClose);
  card.addEventListener('keydown', cancelAutoClose);
  card.addEventListener('input', cancelAutoClose);

  const info = extractProblemInfo();
  const meta = info.slug === d.slug
    ? { title: info.translatedTitle || info.title || undefined, difficulty: difficultyLevel(info.difficulty) }
    : {};
  chrome.runtime.sendMessage({ type: 'SUBMISSION_RESULT', ...d, ...meta }, (res) => {
    const err = chrome.runtime.lastError;
    // 没记上的提交允许再弹：页面之后再报告这次提交时，换一张卡顺带重试
    if ((err || !res?.ok) && d.submissionId) shownSubmissions.delete(d.submissionId);
    if (cardHost !== host) return;
    if (err || !res?.ok) {
      setStatus(
        res?.error === '未登录'
          ? '未登录：请先在网站登录'
          : `记录失败：${res?.error ?? err?.message ?? '未知错误'}`,
        true,
      );
    } else {
      setStatus(res.duplicate ? '已记录' : `已记录 · 用时 ${fmtMs(res.timeMs ?? 0)}`);
    }
  });

  save.addEventListener('click', () => {
    const note = ta.value.trim();
    if (!note) {
      closeCard();
      return;
    }
    save.disabled = true;
    chrome.runtime.sendMessage(
      { type: 'NOTE_SAVE', slug: d.slug, submissionId: d.submissionId, note },
      (res) => {
        const err = chrome.runtime.lastError;
        if (cardHost !== host) return;
        if (err || !res?.ok) {
          setStatus(
            res?.error === '未登录'
              ? '未登录：请先在网站登录'
              : `保存失败：${res?.error ?? err?.message ?? '未知错误'}`,
            true,
          );
          save.disabled = false;
        } else {
          setStatus('心得已保存');
          setTimeout(() => { if (cardHost === host) closeCard(); }, 1200);
        }
      },
    );
  });
  skip.addEventListener('click', closeCard);
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeCard();
  });
}

let retryNotice: HTMLElement | null = null;
function showRetryNotice(action: 'submit' | 'run', attempt: number) {
  if (!retryNotice) {
    retryNotice = document.createElement('div');
    retryNotice.id = 'acb-retry-notice';
    const shadow = retryNotice.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .notice { position: fixed; top: 52px; left: 50%; z-index: 2147483647; transform: translateX(-50%);
        max-width: calc(100vw - 32px); padding: 4px 12px; border-radius: 999px; background: #0f172a; color: #fff;
        font: 12px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
        box-shadow: 0 4px 12px rgba(15, 23, 42, .18); }
    `;
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.setAttribute('role', 'status');
    shadow.append(style, notice);
    document.documentElement.appendChild(retryNotice);
  }
  const notice = retryNotice.shadowRoot?.querySelector('.notice');
  if (notice) notice.textContent = `${action === 'submit' ? '提交' : '运行'}过于频繁，正在自动重试（第 ${attempt} 次）`;
}
const hideRetryNotice = () => {
  retryNotice?.remove();
  retryNotice = null;
};

export default defineContentScript({
  matches: ['https://leetcode.cn/*', 'https://leetcode.com/*'],
  main() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'GET_AGENT_PROBLEM') {
        const info = extractProblemInfo();
        if (!info.slug || info.slug !== msg.slug) {
          sendResponse({ ok: false, error: '题目已经切换，请重新提问' });
          return;
        }
        void (async () => {
          try {
            // 国际版也认 translated* 字段，只是返回空值
            const response = await fetch('/graphql/', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: 'query AgentQuestion($titleSlug: String!) { question(titleSlug: $titleSlug) { title translatedTitle content translatedContent } }',
                variables: { titleSlug: info.slug },
              }),
              signal: AbortSignal.timeout(15000),
            });
            const data = await response.json();
            const question = data?.data?.question;
            if (!response.ok || !question) throw new Error('无法获取完整题干，请确认题目可以正常访问');
            if (slugFromUrl(location.pathname) !== info.slug) throw new Error('题目已经切换，请重新提问');
            const doc = new DOMParser().parseFromString(question.translatedContent || question.content || '', 'text/html');
            doc.querySelectorAll('script, style').forEach((element) => element.remove());
            doc.querySelectorAll('p, div, pre, li, br').forEach((element) => element.append('\n'));
            const description = doc.body.textContent?.trim() ?? '';
            if (!description) throw new Error('当前题目没有可读取的题干');
            sendResponse({ ok: true, ...info, title: question.translatedTitle || question.title, description: description.slice(0, 40000) });
          } catch (error) {
            sendResponse({ ok: false, error: error instanceof Error ? error.message : '读取题干失败' });
          }
        })();
        return true;
      }
      if ((msg as { type?: string } | null)?.type !== 'GET_PROBLEM_INFO') return;
      sendResponse({ ok: true, ...extractProblemInfo() });
    });

    window.addEventListener('message', (e) => {
      // 来源校验不能省：否则 iframe、跨域文档都能伪造 submit-result，往用户账号里写假的作答记录
      if (e.source !== window || e.origin !== location.origin) return;
      const d = e.data as (SubmitDetail & { source?: string; kind?: string; action?: string; attempt?: number }) | null;
      if (d?.source !== 'acb-leetcode-hook') return;
      if (d.kind === 'retry') {
        showRetryNotice(d.action === 'submit' ? 'submit' : 'run', Number(d.attempt) || 1);
        return;
      }
      if (d.kind === 'retry-end') {
        hideRetryNotice();
        return;
      }
      if (d.kind !== 'submit-result') return;
      if (!d.slug || (d.result !== 'pass' && d.result !== 'fail')) return;
      // submissionId 必须透传：页面判题完成后常会再拉一次 check，丢了它去重失效就会双记
      showResultCard({
        slug: d.slug,
        result: d.result,
        verdict: typeof d.verdict === 'string' ? d.verdict : undefined,
        language: d.language,
        submissionId: d.submissionId,
      });
    });

    let seenSlug: string | null = null;
    // 详情页兜底：点提交有时整页跳到 /submissions/<id>/，判题在换页期间完成、详情页不再轮询 check，钩子就错过了
    const DETAIL_RE = /\/problems\/([a-z0-9-]+)\/submissions\/(\d+)/;
    const handledDetail = new Set<string>();
    const checkDetail = async (slug: string, id: string) => {
      for (let i = 0; i < 10; i++) {
        let j: {
          state?: string;
          status_msg?: string;
          lang?: unknown;
          task_finish_time?: number;
        } | null = null;
        try {
          const r = await fetch(`/submissions/detail/${id}/check/`, {
            credentials: 'same-origin',
          });
          j = await r.json();
        } catch {
          j = null;
        }
        if (
          j &&
          (j.state === 'SUCCESS' || j.state === 'FINISHED') &&
          typeof j.status_msg === 'string'
        ) {
          // 10 分钟以前的判题视为浏览历史记录，不自动登记
          if (j.task_finish_time && Date.now() - Number(j.task_finish_time) > 10 * 60 * 1000) {
            return;
          }
          showResultCard({
            slug,
            result: j.status_msg === 'Accepted' ? 'pass' : 'fail',
            verdict: j.status_msg,
            language: typeof j.lang === 'string' ? j.lang : undefined,
            submissionId: id,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    };
    let lastActivityAt = 0;
    let lastTypedAt = 0;

    const reportSeen = () => {
      const slug = slugFromUrl(location.pathname);
      if (slug && slug !== seenSlug) {
        seenSlug = slug;
        lastTypedAt = 0;
        chrome.runtime.sendMessage(
          { type: 'PROBLEM_SEEN', slug, activeAt: lastActivityAt, typedAt: lastTypedAt },
          () => void chrome.runtime.lastError,
        );
      }
      const dm = DETAIL_RE.exec(location.pathname);
      if (dm && dm[1] && dm[2] && !handledDetail.has(dm[2]) && !shownSubmissions.has(dm[2])) {
        handledDetail.add(dm[2]);
        void checkDetail(dm[1], dm[2]);
      }
      if (cardSlug && cardSlug !== slug) closeCard();
    };

    // SPA 换题不触发任何导航事件，content script 在隔离世界里也拿不到页面的 history.pushState，只能轮询 URL
    let urlPoll: number | null = null;
    let heartbeat: number | null = null;

    const sendBeat = () => {
      const slug = slugFromUrl(location.pathname);
      if (!slug) return;
      chrome.runtime.sendMessage(
        { type: 'PROBLEM_BEAT', slug, activeAt: lastActivityAt, typedAt: lastTypedAt },
        () => void chrome.runtime.lastError,
      );
    };

    const markActive = (typed: boolean) => {
      const now = Date.now();
      const eager = now - (typed ? lastTypedAt : lastActivityAt) > BEAT_INTERVAL_MS;
      lastActivityAt = now;
      if (typed) lastTypedAt = now;
      if (eager && document.visibilityState === 'visible') sendBeat();
    };
    const onInput = (event: Event) =>
      markActive(event.type === 'keydown' && event.target instanceof Element && !!event.target.closest('.monaco-editor'));
    for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
      document.addEventListener(type, onInput, { capture: true, passive: true });
    }
    document.addEventListener('mousemove', () => {
      if (Date.now() - lastActivityAt > 1_000) markActive(false);
    }, { capture: true, passive: true });
    window.addEventListener('focus', () => markActive(false));

    const syncLoops = () => {
      if (document.visibilityState === 'visible') {
        reportSeen();
        sendBeat();
        if (urlPoll == null) urlPoll = window.setInterval(reportSeen, 1000);
        if (heartbeat == null) heartbeat = window.setInterval(sendBeat, BEAT_INTERVAL_MS);
        return;
      }
      if (urlPoll != null) {
        window.clearInterval(urlPoll);
        urlPoll = null;
      }
      if (heartbeat != null) {
        window.clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') lastActivityAt = Date.now();
      syncLoops();
    });
    window.addEventListener('pagehide', () => {
      if (urlPoll != null) window.clearInterval(urlPoll);
      if (heartbeat != null) window.clearInterval(heartbeat);
      urlPoll = null;
      heartbeat = null;
    });
    syncLoops();
  },
});
