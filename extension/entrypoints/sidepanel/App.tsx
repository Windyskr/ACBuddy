import { useEffect, useRef, useState } from 'react';
import { getMe, getProgress, openSite, type Progress } from '../lib/api';
import { PLATFORMS, problemLabel, type ProblemHeader } from '../lib/platforms';
import { IDLE_MINUTES, type TimerStatus } from '../lib/timing';
import AgentChat from './AgentChat';
import { PauseIcon, PlayIcon, RestartIcon } from './icons';
import './panel.css';

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const MASTERY_LABEL = ['未做', '了解', '一般', '掌握', '熟练', '精通'];

type PageState = 'loading' | 'problem' | 'other' | 'error';
type Toast = { text: string; tone: 'pass' | 'fail' | 'info' };
type Timer = TimerStatus & { at: number };
// 计时、进度和自动记录只有力扣有（按 slug 存）；其他平台的题返回 null
const trackedSlug = (problem: ProblemHeader | null) => (problem && PLATFORMS[problem.platform].tracked ? problem.id : null);

export default function App() {
  const [toast, setToast] = useState<Toast | null>(null);
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [page, setPage] = useState<PageState>('loading');
  const [pageError, setPageError] = useState('');
  const [problem, setProblem] = useState<ProblemHeader | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [timer, setTimer] = useState<Timer | null>(null);
  const [, setTick] = useState(0);
  const problemRef = useRef<ProblemHeader | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const refreshMe = () => {
      void (async () => {
        const m = await getMe();
        setMe(m?.user.username ?? null);
      })();
    };
    refreshMe();
    fetchProblem();
    const sync = () => {
      refreshMe();
      fetchProblem();
    };
    // 页面内切题（地址变了、没有整页加载）也要刷新顶栏
    const onUpdated = (_tabId: number, change: { url?: string }, tab: chrome.tabs.Tab) => {
      if (change.url && tab.active) fetchProblem();
    };
    window.addEventListener('focus', sync);
    chrome.tabs.onActivated.addListener(sync);
    chrome.tabs.onUpdated.addListener(onUpdated);
    const onBg = (msg: { type?: string; slug?: string; result?: string }) => {
      if (msg.type === 'PROBLEM_CHANGED') {
        fetchProblem();
        return;
      }
      if (msg.type === 'TIMER_STATE') {
        applyTimer(msg as unknown as TimerStatus);
        return;
      }
      if (msg.type === 'ATTEMPT_REPORTED') {
        setToast(msg.result === 'pass'
          ? { text: '已记录：通过 ✓', tone: 'pass' }
          : { text: '已记录：未通过 ✗', tone: 'fail' });
        if (msg.slug && trackedSlug(problemRef.current) === msg.slug) void loadProgress(msg.slug);
      } else if (msg.type === 'NOTE_SAVED' && msg.slug && trackedSlug(problemRef.current) === msg.slug) {
        setToast({ text: '心得已保存', tone: 'info' });
        void loadProgress(msg.slug);
      }
    };
    chrome.runtime.onMessage.addListener(onBg);
    return () => {
      window.removeEventListener('focus', sync);
      chrome.tabs.onActivated.removeListener(sync);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onBg);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  const timerSlug = trackedSlug(problem);
  useEffect(() => {
    const slug = timerSlug;
    if (slug == null) return;
    let ticks = 0;
    const t = setInterval(() => {
      ticks += 1;
      if (ticks % 5 === 0) loadTimer(slug);
      else setTick(ticks);
    }, 1000);
    return () => clearInterval(t);
  }, [timerSlug]);

  useEffect(() => {
    let lastSent = 0;
    const onActivity = () => {
      const slug = trackedSlug(problemRef.current);
      if (!slug || Date.now() - lastSent < 10_000) return;
      lastSent = Date.now();
      chrome.runtime.sendMessage({ type: 'PANEL_ACTIVITY', slug }, () => void chrome.runtime.lastError);
    };
    const events = ['pointerdown', 'keydown', 'wheel'];
    for (const type of events) document.addEventListener(type, onActivity, { capture: true, passive: true });
    return () => {
      for (const type of events) document.removeEventListener(type, onActivity, { capture: true });
    };
  }, []);

  const applyTimer = (status: TimerStatus) => {
    if (status.slug && status.slug === trackedSlug(problemRef.current)) setTimer({ ...status, at: Date.now() });
  };
  const loadTimer = (slug: string) => {
    chrome.runtime.sendMessage({ type: 'GET_TIMER', slug }, (res) => {
      if (!chrome.runtime.lastError && res?.ok) applyTimer(res as TimerStatus);
    });
  };
  const controlTimer = (action: 'pause' | 'resume' | 'restart') => {
    const slug = trackedSlug(problemRef.current);
    if (!slug) return;
    chrome.runtime.sendMessage({ type: 'TIMER_CONTROL', slug, action }, (res) => {
      if (!chrome.runtime.lastError && res?.ok) applyTimer(res as TimerStatus);
    });
  };

  const loadProgress = async (slug: string) => {
    try {
      const data = await getProgress(slug);
      setProgress(data.progress);
    } catch {
      setProgress(null);
    }
  };

  const fetchProblem = (retriesLeft = 12) => {
    if (retryTimerRef.current != null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    chrome.runtime.sendMessage({ type: 'GET_PROBLEM_INFO' }, (res: unknown) => {
      const err = chrome.runtime.lastError;
      const p = err ? null : (res as { ok: boolean; error?: string; problem?: ProblemHeader | null } | null);
      if (err || !p?.ok) {
        if (retriesLeft > 0) {
          retryTimerRef.current = window.setTimeout(() => fetchProblem(retriesLeft - 1), 2000);
          return;
        }
        setProblem(null);
        problemRef.current = null;
        setProgress(null);
        setPage('error');
        setPageError(err?.message ?? p?.error ?? '');
        return;
      }
      if (p.problem) {
        const next = p.problem;
        if (problemRef.current?.key !== next.key) setTimer(null);
        setProblem(next);
        problemRef.current = next;
        setPage('problem');
        const slug = trackedSlug(next);
        if (slug) {
          loadTimer(slug);
          void loadProgress(slug);
        } else setProgress(null);
      } else {
        setProblem(null);
        problemRef.current = null;
        setProgress(null);
        setPage('other');
      }
    });
  };

  const problemTitle = problem && problemLabel(problem.number, problem.title);
  const tracked = !!timerSlug;
  const paused = timer?.paused ?? null;
  const seconds = timer ? Math.floor((timer.elapsedMs + (paused ? 0 : Date.now() - timer.at)) / 1000) : 0;
  const timerTip = paused === 'manual' ? '已手动暂停：点继续，或在编辑器里改代码时自动继续'
    : paused === 'idle' ? `${IDLE_MINUTES} 分钟没有操作，已自动暂停，离开的时间不计入；回到题目页有操作就接着计`
    : paused === 'done' ? '提交通过后停止计时：在编辑器里改代码或点开始，重新计时'
    : '本题用时：只统计页面在前台、并且有操作的时间';
  const mastery = Math.min(5, Math.max(0, Math.round(progress?.mastery ?? 0)));
  const header = <>
    {problem ? (
      <div className="panel-problem">
        <span className="panel-problem-title" title={problemTitle ?? undefined}>{problemTitle}</span>
        {problem.difficulty && (
          <span className={`badge${problem.difficulty.tone ? ` badge-${problem.difficulty.tone}` : ''}`}>{problem.difficulty.label}</span>
        )}
      </div>
    ) : (
      <div className="panel-problem panel-problem-empty" title={page === 'error' ? pageError : undefined}>
        {page === 'loading' ? '正在读取题目…' : page === 'error' ? '无法读取题目，请刷新题目页面' : '未打开题目页面'}
      </div>
    )}
    {me === null && (!problem || tracked) ? (
      <p className="panel-banner">
        <span>未登录，作答不会被记录</span>
        <button type="button" onClick={() => openSite()}>去网站登录</button>
      </p>
    ) : problem && me && tracked && (
      <div className="panel-meta">
        <span className="panel-timer" title={timerTip}>
          {paused === 'done' ? '计时已停' : <>{paused ? '已暂停' : '计时'} <b className={paused ? 'is-paused' : undefined}>{fmt(seconds)}</b></>}
          {paused ? <>
            <button type="button" className="icon-button timer-button" aria-label={paused === 'done' ? '开始计时' : '继续计时'}
              title={paused === 'done' ? '开始计时' : '继续'} onClick={() => controlTimer('resume')}><PlayIcon /></button>
            {paused !== 'done' && (
              <button type="button" className="icon-button timer-button" aria-label="从 0 开始计时" title="从 0 开始"
                onClick={() => controlTimer('restart')}><RestartIcon /></button>
            )}
          </> : (
            <button type="button" className="icon-button timer-button" aria-label="暂停计时" title="暂停"
              onClick={() => controlTimer('pause')}><PauseIcon /></button>
          )}
        </span>
        {progress && <>
          <span className={`badge badge-${progress.done ? 'pass' : 'fail'}`}>{progress.done ? '已通过' : '未通过'}</span>
          <span>{progress.attemptCount} 次作答</span>
          {mastery > 0 && (
            <span className="stars" role="img" aria-label={`掌握程度：${MASTERY_LABEL[mastery]}`} title={`掌握程度：${MASTERY_LABEL[mastery]}`}>
              {'★'.repeat(mastery)}<span className="stars-off">{'★'.repeat(5 - mastery)}</span>
            </span>
          )}
        </>}
      </div>
    )}
    {toast && <div className={`panel-toast panel-toast-${toast.tone}`} role="status">{toast.text}</div>}
  </>;

  return (
    <main className="app">
      <AgentChat problemKey={problem?.key ?? null} account={me} header={header} />
    </main>
  );
}
