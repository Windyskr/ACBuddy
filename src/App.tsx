import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import rawJson from "./data/problems.json?raw";
import type {
  AuthUser,
  ColumnKey,
  Filters,
  ProblemData,
  ProgressView,
  ProgressViewMap,
  ServerProgress,
  SortKey,
  SortState,
} from "./types";
import { useLocalStorage } from "./lib/storage";
import { api } from "./lib/api";
import { DEFAULT_HIDDEN_COLUMNS, EMPTY_VIEW, NATURAL_DIR, filterProblems, isColumnKey, sortProblems, viewOf } from "./lib/filters";
import type { LeetCodeSite } from "./lib/leetcode";
import Header from "./components/Header";
import FilterBar from "./components/FilterBar";
import ProblemTable from "./components/ProblemTable";
import Pagination from "./components/Pagination";
import AuthModal from "./components/AuthModal";
import ChangePasswordModal from "./components/ChangePasswordModal";
import InstallGuide from "./components/InstallGuide";

const DATA = JSON.parse(rawJson) as ProblemData;
const IS_INSTALL_PAGE = window.location.pathname.replace(/\/+$/, "") === "/install";

type ProgressPatch = {
  done?: boolean;
  mastery?: number;
  urgency?: number;
  tags?: string[];
  note?: string;
};

const MASTERED = 5;

const REFRESH_MIN_INTERVAL_MS = 30_000;
const MAX_MERGE_SLUGS = 300;
const MERGE_CONCURRENCY = 4;

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DEFAULT_FILTERS: Filters = {
  keyword: "",
  difficulties: [],
  mastery: [],
  latestResult: "",
  tag: "",
  userTag: "",
};

function normalizeFilters(f: Partial<Filters> | null): Filters {
  return {
    ...DEFAULT_FILTERS,
    ...f,
    difficulties: Array.isArray(f?.difficulties) ? f.difficulties : [],
    mastery: Array.isArray(f?.mastery) ? f.mastery : [],
    latestResult:
      f?.latestResult === "pass" || f?.latestResult === "fail" || f?.latestResult === "unattempted"
        ? f.latestResult
        : "",
  };
}

async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

export default function App() {
  const [storedFilters, setStoredFilters] = useLocalStorage<Filters>("acb.filters.v1", DEFAULT_FILTERS);
  const filters = useMemo(() => normalizeFilters(storedFilters), [storedFilters]);
  const [sort, setSort] = useState<SortState>({ key: null, dir: "asc" });
  const [page, setPage] = useLocalStorage("acb.page.v1", 1);
  const [pageSize, setPageSize] = useLocalStorage("acb.pageSize.v1", 20);
  // 首次访问就会把默认值写进 localStorage，改默认值要换键名，否则老访客看不到
  const [storedHiddenColumns, setHiddenColumns] = useLocalStorage<ColumnKey[]>("acb.columns.v2", DEFAULT_HIDDEN_COLUMNS);
  const hiddenColumns = useMemo(() => storedHiddenColumns.filter(isColumnKey), [storedHiddenColumns]);
  const [leetcodeSite, setLeetcodeSite] = useLocalStorage<LeetCodeSite>("acb.leetcodeSite.v1", "leetcode.cn");
  const [authOpen, setAuthOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  const [failedProgressUpdate, setFailedProgressUpdate] = useState<{
    id: number;
    slug: string;
    patch: ProgressPatch;
    message: string;
  } | null>(null);

  const [guestMastery, setGuestMastery] = useLocalStorage<Record<string, number>>("acb.mastery.v1", {});
  const [guestUrgency, setGuestUrgency] = useLocalStorage<Record<string, number>>("acb.urgency.v1", {});
  const [guestNotes, setGuestNotes] = useLocalStorage<Record<string, string>>("acb.notes.v1", {});
  const [progressBySlug, setProgressBySlug] = useState<Record<string, ServerProgress>>({});

  const authed = authUser !== null;

  const authUserRef = useRef(authUser);
  const progressSyncIdRef = useRef(0);
  const progressRefreshTimerRef = useRef<number | null>(null);
  const lastSyncAtRef = useRef(0);
  const progressMutationIdRef = useRef(0);
  const latestMutationBySlugRef = useRef(new Map<string, number>());
  const progressRef = useRef(progressBySlug);
  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);
  useEffect(() => {
    progressRef.current = progressBySlug;
  }, [progressBySlug]);

  const syncFromServer = useCallback(async () => {
    const syncId = ++progressSyncIdRef.current;
    const userId = authUserRef.current?.id;
    const rows = await api<ServerProgress[]>("/progress?platform=leetcode");
    if (syncId !== progressSyncIdRef.current || authUserRef.current?.id !== userId) return;
    lastSyncAtRef.current = Date.now();
    setProgressBySlug(Object.fromEntries(rows.map((row) => [row.slug, row])));
  }, []);

  const mergeGuestData = useCallback(async () => {
    const slugs = [
      ...new Set([
        ...Object.keys(guestMastery),
        ...Object.keys(guestUrgency),
        ...Object.keys(guestNotes),
      ]),
    ];
    const server = progressRef.current;
    const pending = slugs
      .filter((slug) => {
        const row = server[slug];
        return !row || (row.mastery === 0 && row.urgency === 0 && !row.note);
      })
      .slice(0, MAX_MERGE_SLUGS);
    if (pending.length === 0) return;

    const merged: string[] = [];
    await runPool(pending, MERGE_CONCURRENCY, async (slug) => {
      const patch: ProgressPatch = {};
      if (guestMastery[slug]) patch.mastery = guestMastery[slug];
      if (guestUrgency[slug]) patch.urgency = guestUrgency[slug];
      if (guestNotes[slug]) patch.note = guestNotes[slug];
      if (Object.keys(patch).length === 0) return;
      try {
        const { progress } = await api<{ progress: ServerProgress }>(`/progress/leetcode/${slug}`, {
          method: "PUT",
          body: patch,
        });
        setProgressBySlug((current) => ({ ...current, [slug]: progress }));
        merged.push(slug);
      } catch {
      }
    });

    if (merged.length === 0) return;
    const drop = <T,>(map: Record<string, T>) => {
      const next = { ...map };
      for (const slug of merged) delete next[slug];
      return next;
    };
    setGuestMastery(drop);
    setGuestUrgency(drop);
    setGuestNotes(drop);
    setMergeNotice(`已把本地记录的 ${merged.length} 道题同步到账号「${authUserRef.current?.username}」`);
  }, [guestMastery, guestUrgency, guestNotes, setGuestMastery, setGuestUrgency, setGuestNotes]);

  const authReadyRef = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (authReadyRef.current) return;
    const authReady = api<{ user: AuthUser }>("/auth/me")
      .then(async (data) => {
        authUserRef.current = data.user;
        setAuthUser(data.user);
        await syncFromServer();
      })
      .catch(() => {});
    authReadyRef.current = authReady;
  }, [syncFromServer]);

  useEffect(() => {
    if (IS_INSTALL_PAGE) return;
    const onFirstOp = () => {
      document.removeEventListener("pointerdown", onFirstOp, true);
      void authReadyRef.current?.then(() => {
        if (authUserRef.current) return;
        if (localStorage.getItem("acb.tip.lastShown.v1") === localDateStr()) return;
        localStorage.setItem("acb.tip.lastShown.v1", localDateStr());
        setTipOpen(true);
      });
    };
    document.addEventListener("pointerdown", onFirstOp, true);
    return () => document.removeEventListener("pointerdown", onFirstOp, true);
  }, []);

  useEffect(() => {
    if (!authUser) return;
    const refreshProgress = () => {
      if (document.visibilityState !== "visible" || progressRefreshTimerRef.current !== null) return;
      if (Date.now() - lastSyncAtRef.current < REFRESH_MIN_INTERVAL_MS) return;
      progressRefreshTimerRef.current = window.setTimeout(() => {
        progressRefreshTimerRef.current = null;
        void syncFromServer().catch(() => {});
      }, 150);
    };
    window.addEventListener("focus", refreshProgress);
    document.addEventListener("visibilitychange", refreshProgress);
    return () => {
      window.removeEventListener("focus", refreshProgress);
      document.removeEventListener("visibilitychange", refreshProgress);
      if (progressRefreshTimerRef.current !== null) {
        window.clearTimeout(progressRefreshTimerRef.current);
        progressRefreshTimerRef.current = null;
      }
    };
  }, [authUser, syncFromServer]);

  async function pushProgress(slug: string, patch: ProgressPatch) {
    if (!authUserRef.current) return;
    const mutationId = ++progressMutationIdRef.current;
    latestMutationBySlugRef.current.set(slug, mutationId);
    try {
      const { progress } = await api<{ progress: ServerProgress }>(`/progress/leetcode/${slug}`, {
        method: "PUT",
        body: patch,
      });
      setProgressBySlug((current) => ({ ...current, [slug]: progress }));
      setFailedProgressUpdate((current) =>
        current?.slug === slug && current.id <= mutationId ? null : current,
      );
    } catch (error) {
      if (latestMutationBySlugRef.current.get(slug) === mutationId) {
        setFailedProgressUpdate({
          id: mutationId,
          slug,
          patch,
          message: error instanceof Error ? error.message : "保存失败，请重试",
        });
      }
    }
  }

  const problems = DATA.problems;

  const views: ProgressViewMap = useMemo(() => {
    const out: ProgressViewMap = {};
    if (authed) {
      for (const [slug, row] of Object.entries(progressBySlug)) {
        out[slug] = {
          mastery: row.mastery,
          urgency: row.urgency,
          note: row.note ?? "",
          tags: row.tags,
          lastResult: row.lastResult,
          lastAttemptAt: row.lastAttemptAt,
          done: row.done || row.mastery >= MASTERED,
        };
      }
      return out;
    }
    const touch = (slug: string): ProgressView =>
      (out[slug] ??= { ...EMPTY_VIEW, tags: [] });
    for (const [slug, value] of Object.entries(guestMastery)) {
      if (!value) continue;
      const view = touch(slug);
      view.mastery = value;
      view.done = value >= MASTERED;
    }
    for (const [slug, value] of Object.entries(guestUrgency)) {
      if (value) touch(slug).urgency = value;
    }
    for (const [slug, value] of Object.entries(guestNotes)) {
      if (value) touch(slug).note = value;
    }
    return out;
  }, [authed, progressBySlug, guestMastery, guestUrgency, guestNotes]);

  const activeFilters = useMemo(
    () =>
      authed || (filters.latestResult === "" && filters.userTag === "")
        ? filters
        : { ...filters, latestResult: "" as const, userTag: "" },
    [authed, filters],
  );
  const filtered = useMemo(
    () => sortProblems(filterProblems(problems, activeFilters, views), sort, views),
    [problems, activeFilters, views, sort],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(Math.trunc(page) || 1, 1), totalPages);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage, setPage]);

  useEffect(() => {
    if (!tipOpen) return;
    const timer = window.setTimeout(() => setTipOpen(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [tipOpen]);

  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setPage(1);
  }, [filters, sort, pageSize]);

  const stats = useMemo(() => {
    let doneTotal = 0;
    let easy = 0;
    let medium = 0;
    let hard = 0;
    for (const p of filtered) {
      if (!viewOf(views, p.slug).done) continue;
      doneTotal += 1;
      if (p.difficulty === "EASY") easy += 1;
      else if (p.difficulty === "MEDIUM") medium += 1;
      else hard += 1;
    }
    return { total: filtered.length, done: doneTotal, easy, medium, hard };
  }, [filtered, views]);

  const tagsWithCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of problems) {
      for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [problems]);

  const userTagsWithCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of problems) {
      for (const t of viewOf(views, p.slug).tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
  }, [problems, views]);

  function patchFilters(patch: Partial<Filters>) {
    setStoredFilters((f) => ({ ...normalizeFilters(f), ...patch }));
  }

  function handleSort(key: SortKey) {
    setSort((current) => {
      if (current.key !== key) return { key, dir: NATURAL_DIR[key] };
      if (current.dir === NATURAL_DIR[key]) {
        return { key, dir: current.dir === "asc" ? "desc" : "asc" };
      }
      return { key: null, dir: "asc" };
    });
  }

  function writeProgress(slug: string, patch: ProgressPatch, applyLocally: () => void) {
    if (authed) {
      void pushProgress(slug, patch);
      return;
    }
    applyLocally();
  }

  function setMasteryFor(slug: string, value: number) {
    writeProgress(slug, { mastery: value }, () =>
      setGuestMastery((m) => {
        const next = { ...m };
        if (value > 0) next[slug] = value;
        else delete next[slug];
        return next;
      }),
    );
  }

  function setUrgencyFor(slug: string, value: number) {
    writeProgress(slug, { urgency: value }, () =>
      setGuestUrgency((m) => {
        const next = { ...m };
        if (value > 0) next[slug] = value;
        else delete next[slug];
        return next;
      }),
    );
  }

  function saveNote(slug: string, text: string) {
    writeProgress(slug, { note: text }, () =>
      setGuestNotes((n) => {
        const next = { ...n };
        if (text) next[slug] = text;
        else delete next[slug];
        return next;
      }),
    );
  }

  function setTagsFor(slug: string, tags: string[]) {
    if (!authed) {
      setAuthOpen(true);
      return;
    }
    void pushProgress(slug, { tags });
  }

  function handleLoginSuccess(user: AuthUser) {
    authUserRef.current = user;
    setAuthUser(user);
    setAuthOpen(false);
    void syncFromServer()
      .then(() => mergeGuestData())
      .catch(() => {});
  }

  function handleLogout() {
    api("/auth/logout", { method: "POST" }).catch(() => {});
    authUserRef.current = null;
    setAuthUser(null);
    setProgressBySlug({});
    setFailedProgressUpdate(null);
    setMergeNotice(null);
  }

  function resetFilters() {
    setStoredFilters(DEFAULT_FILTERS);
  }

  function toggleColumn(key: ColumnKey) {
    setHiddenColumns((cols) =>
      cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key],
    );
  }

  return (
    <div className="min-h-screen">
      <Header
        user={authUser}
        installPage={IS_INSTALL_PAGE}
        onLoginClick={() => setAuthOpen(true)}
        onPasswordChange={() => setPasswordOpen(true)}
        onLogout={handleLogout}
      />

      {IS_INSTALL_PAGE ? (
        <InstallGuide authed={authed} onLogin={() => setAuthOpen(true)} />
      ) : (
        <main className="mx-auto w-full max-w-6xl px-4 pb-10">
          {mergeNotice && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700" role="status">
              <span>{mergeNotice}</span>
              <button
                type="button"
                className="shrink-0 rounded-md px-2 py-1 text-emerald-600 hover:bg-emerald-100"
                onClick={() => setMergeNotice(null)}
                aria-label="关闭提示"
              >
                ✕
              </button>
            </div>
          )}
          {failedProgressUpdate && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
              <span>进度保存失败：{failedProgressUpdate.message}</span>
              <button
                type="button"
                className="shrink-0 rounded-md bg-white px-2.5 py-1 font-medium text-rose-700 shadow-sm hover:bg-rose-100"
                onClick={() => void pushProgress(failedProgressUpdate.slug, failedProgressUpdate.patch)}
              >
                重试保存
              </button>
            </div>
          )}
          <FilterBar
            filters={activeFilters}
            tags={tagsWithCount}
            userTags={userTagsWithCount}
            stats={stats}
            authed={authed}
            onPatch={patchFilters}
            onReset={resetFilters}
            hiddenColumns={hiddenColumns}
            onToggleColumn={toggleColumn}
            leetcodeSite={leetcodeSite}
            onLeetcodeSite={setLeetcodeSite}
          />

          <ProblemTable
            items={pageItems}
            sort={sort}
            hiddenColumns={hiddenColumns}
            leetcodeSite={leetcodeSite}
            views={views}
            authed={authed}
            onSort={handleSort}
            onMastery={setMasteryFor}
            onUrgency={setUrgencyFor}
            onSaveNote={saveNote}
            onTags={setTagsFor}
            onProgressChange={(slug, progress) => {
              setProgressBySlug((current) => {
                const next = { ...current };
                if (progress) next[slug] = progress;
                else delete next[slug];
                return next;
              });
            }}
            onLogin={() => setAuthOpen(true)}
          />

          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <footer className="flex gap-x-4 text-xs text-slate-400">
              <a className="hover:text-slate-600 hover:underline" href="/install">
                安装插件
              </a>
              <a className="hover:text-slate-600 hover:underline" href="https://github.com/Windyskr/acbuddy" target="_blank" rel="noreferrer">
                GitHub
              </a>
              <a className="hover:text-slate-600 hover:underline" href="/privacy.html" target="_blank" rel="noreferrer">
                隐私政策
              </a>
            </footer>
            <Pagination
              total={filtered.length}
              page={safePage}
              totalPages={totalPages}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={setPageSize}
            />
          </div>
        </main>
      )}

      {tipOpen && !authed && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-slate-200 bg-white py-2.5 pl-4 pr-2 text-sm text-slate-600 shadow-lg"
        >
          <span>登录后可同步作答记录与插件心得</span>
          <button
            type="button"
            onClick={() => {
              setTipOpen(false);
              setAuthOpen(true);
            }}
            className="shrink-0 rounded-lg px-2 py-1 font-medium text-blue-600 hover:bg-blue-50"
          >
            登录
          </button>
          <button
            type="button"
            onClick={() => setTipOpen(false)}
            aria-label="关闭提示"
            className="shrink-0 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
      )}
      {authOpen && (
        <AuthModal onClose={() => setAuthOpen(false)} onSuccess={handleLoginSuccess} />
      )}
      {passwordOpen && authUser && <ChangePasswordModal onClose={() => setPasswordOpen(false)} />}
    </div>
  );
}
