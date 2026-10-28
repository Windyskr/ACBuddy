import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { LEETCODE_SITE_LABEL, verdictLabel, type LeetCodeSite } from "../lib/leetcode";
import type { ServerProgress } from "../types";

interface AttemptItem {
  id: number;
  slug: string;
  site: LeetCodeSite;
  result: "pass" | "fail";
  verdict: string | null;
  timeMs: number | null;
  language: string | null;
  submissionId: string | null;
  note: string | null;
  createdAt: string | null;
}

interface AttemptTimelineProps {
  slug: string;
  leetcodeSite: LeetCodeSite;
  authed: boolean;
  onProgressChange: (slug: string, progress: ServerProgress | null) => void;
  onLogin: () => void;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hoursAndMinutes = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const monthAndDay = `${date.getMonth() + 1}月${date.getDate()}日 ${hoursAndMinutes}`;
  return date.getFullYear() === new Date().getFullYear()
    ? monthAndDay
    : `${date.getFullYear()}年${monthAndDay}`;
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export default function AttemptTimeline({ slug, leetcodeSite, authed, onProgressChange, onLogin }: AttemptTimelineProps) {
  const [state, setState] = useState<{ loading: boolean; attempts: AttemptItem[] | null }>({
    loading: authed,
    attempts: null,
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editTextRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    api<{ attempts: AttemptItem[] }>(`/progress/leetcode/${slug}`)
      .then((data) => {
        if (!cancelled) setState({ loading: false, attempts: data.attempts });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, attempts: null });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, authed]);

  async function saveEdit(id: number) {
    const text = editTextRef.current?.value ?? "";
    setBusy(true);
    setError(null);
    try {
      const { attempt } = await api<{ attempt: AttemptItem }>(`/attempts/${id}`, {
        method: "PUT",
        body: { note: text },
      });
      setState(({ attempts }) => ({
        loading: false,
        attempts: attempts?.map((item) => (item.id === id ? attempt : item)) ?? null,
      }));
      setEditingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function removeAttempt(id: number) {
    setBusy(true);
    setError(null);
    try {
      const { progress } = await api<{ progress: ServerProgress | null }>(`/attempts/${id}`, {
        method: "DELETE",
      });
      setState(({ attempts }) => ({
        loading: false,
        attempts: attempts?.filter((item) => item.id !== id) ?? null,
      }));
      onProgressChange(slug, progress);
      setDeletingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  if (!authed) {
    return (
      <p className="mt-3 text-xs text-slate-400">
        <button type="button" onClick={onLogin} className="font-medium text-blue-600 hover:underline">
          登录
        </button>
        后可查看历次作答与心得（与浏览器插件同步）
      </p>
    );
  }
  if (state.loading) return <p className="mt-3 text-xs text-slate-400">加载作答记录…</p>;
  if (!state.attempts) return <p className="mt-3 text-xs text-slate-400">作答记录加载失败</p>;
  if (state.attempts.length === 0) {
    return <p className="mt-3 text-xs text-slate-400">还没有作答记录，插件上报后会显示在这里</p>;
  }

  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-slate-500">作答记录（{state.attempts.length} 次）</p>
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
      <ol className="mt-2 space-y-2.5">
        {state.attempts.map((attempt) => (
          <li key={attempt.id} className="group relative pl-4">
            <span className={`absolute left-0 top-1 h-2 w-2 rounded-full ${attempt.result === "pass" ? "bg-emerald-500" : "bg-slate-300"}`} />
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
              {attempt.submissionId ? (
                <a
                  href={`https://${attempt.site}/problems/${attempt.slug}/submissions/${attempt.submissionId}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-x-2 rounded hover:underline"
                >
                  <AttemptSummary attempt={attempt} />
                </a>
              ) : (
                <AttemptSummary attempt={attempt} />
              )}
              <span>耗时 {formatDuration(attempt.timeMs)}</span>
              {attempt.language && <span>· {attempt.language}</span>}
              {attempt.site !== leetcodeSite && <span>· {LEETCODE_SITE_LABEL[attempt.site] ?? attempt.site}</span>}
              {editingId !== attempt.id && deletingId !== attempt.id && (
                <span className="ml-auto flex gap-1 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0">
                  <button type="button" onClick={() => { setEditingId(attempt.id); setDeletingId(null); }} className="rounded px-1 hover:text-blue-600">编辑</button>
                  <button type="button" onClick={() => { setDeletingId(attempt.id); setEditingId(null); }} className="rounded px-1 hover:text-rose-600">删除</button>
                </span>
              )}
            </div>

            {editingId === attempt.id ? (
              <div className="mt-1.5">
                <textarea
                  ref={editTextRef}
                  autoFocus
                  defaultValue={attempt.note ?? ""}
                  rows={3}
                  placeholder="修改这一次的心得（时间不可修改），支持简单 Markdown…"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void saveEdit(attempt.id);
                    } else if (event.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  className="w-full rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-blue-400"
                />
                <div className="mt-1.5 flex gap-1.5">
                  <button type="button" disabled={busy} onClick={() => void saveEdit(attempt.id)} className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">保存</button>
                  <button type="button" disabled={busy} onClick={() => setEditingId(null)} className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50">取消</button>
                </div>
              </div>
            ) : attempt.note ? (
              <div className="md-content mt-0.5 text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: renderMarkdown(attempt.note) }} />
            ) : null}
          </li>
        ))}
      </ol>

      {deletingId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setDeletingId(null)}>
          <div className="w-72 rounded-xl bg-white p-4 shadow-xl" role="dialog" aria-label="确认删除作答记录" onClick={(event) => event.stopPropagation()}>
            <p className="text-sm font-medium text-slate-800">删除这条作答记录？</p>
            <p className="mt-1 text-xs text-slate-400">删除后不可恢复，该题耗时与通过状态将同步重算。</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setDeletingId(null)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50">取消</button>
              <button type="button" disabled={busy} onClick={() => void removeAttempt(deletingId)} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50">删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AttemptSummary({ attempt }: { attempt: AttemptItem }) {
  return (
    <>
      <span className="tabular-nums">{formatTime(attempt.createdAt)}</span>
      <span className={`font-medium ${attempt.result === "pass" ? "text-emerald-600" : "text-slate-400"}`}>
        {attempt.result === "pass" ? "通过" : attempt.verdict ? verdictLabel(attempt.verdict) : "未通过"}
      </span>
    </>
  );
}
