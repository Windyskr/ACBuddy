import type {
  ColumnKey,
  Difficulty,
  Filters,
  Problem,
  ProgressView,
  ProgressViewMap,
  SortDir,
  SortKey,
  SortState,
} from "../types";

export const DIFFICULTY_ORDER: Record<Difficulty, number> = {
  EASY: 0,
  MEDIUM: 1,
  HARD: 2,
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  EASY: "简单",
  MEDIUM: "中等",
  HARD: "困难",
};

export const NATURAL_DIR: Record<SortKey, SortDir> = {
  id: "asc",
  difficulty: "asc",
  lastAttempt: "desc",
  mastery: "desc",
};

export const MASTERY_LABEL = ["未做", "了解", "一般", "掌握", "熟练", "精通"];

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  difficulty: "难度",
  tags: "标签",
  recent: "最近作答",
  urgency: "紧急",
  mastery: "掌握程度",
  userTags: "个人标签",
};

export const LOGIN_COLUMNS: ColumnKey[] = ["recent", "userTags"];

export const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["urgency"];

export const isColumnKey = (key: string): key is ColumnKey => key in COLUMN_LABEL;

function idRank(id: string): number {
  const n = Number.parseInt(id, 10);
  return Number.isFinite(n) ? n : 1_000_000;
}

export const EMPTY_VIEW: ProgressView = Object.freeze({
  mastery: 0,
  urgency: 0,
  note: "",
  tags: [],
  lastResult: null,
  lastAttemptAt: null,
  done: false,
});

export const viewOf = (views: ProgressViewMap, slug: string): ProgressView =>
  views[slug] ?? EMPTY_VIEW;

export function filterProblems(
  problems: Problem[],
  f: Filters,
  views: ProgressViewMap,
): Problem[] {
  const kw = f.keyword.trim().toLowerCase();
  return problems.filter((p) => {
    if (kw && !(p.title.toLowerCase().includes(kw) || (p.id !== "" && p.id.startsWith(kw)))) {
      return false;
    }
    if (f.difficulties.length > 0 && !f.difficulties.includes(p.difficulty)) return false;
    const view = viewOf(views, p.slug);
    if (f.mastery.length > 0 && !f.mastery.includes(view.mastery)) return false;
    if (f.latestResult === "pass" && view.lastResult !== "pass") return false;
    if (f.latestResult === "fail" && view.lastResult !== "fail") return false;
    if (f.latestResult === "unattempted" && view.lastResult !== null) return false;
    if (f.tag && !p.tags.includes(f.tag)) return false;
    if (f.userTag && !view.tags.includes(f.userTag)) return false;
    return true;
  });
}

export function sortProblems(
  list: Problem[],
  sort: SortState,
  views: ProgressViewMap = {},
): Problem[] {
  if (sort.key === null) return list;
  const mul = sort.dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case "id":
        cmp = idRank(a.id) - idRank(b.id);
        break;
      case "difficulty":
        cmp = DIFFICULTY_ORDER[a.difficulty] - DIFFICULTY_ORDER[b.difficulty];
        break;
      case "lastAttempt": {
        const aAt = viewOf(views, a.slug).lastAttemptAt;
        const bAt = viewOf(views, b.slug).lastAttemptAt;
        const aTime = aAt ? Date.parse(aAt) : 0;
        const bTime = bAt ? Date.parse(bAt) : 0;
        if (aTime === 0 && bTime === 0) return 0;
        // 未做题目升序、降序都排在末尾
        if (aTime === 0) return 1;
        if (bTime === 0) return -1;
        cmp = aTime - bTime;
        break;
      }
      case "mastery":
        cmp = viewOf(views, a.slug).mastery - viewOf(views, b.slug).mastery;
        break;
    }
    // 相同时返回 0，靠稳定排序保留题库顺序（即列表默认顺序）
    return mul * cmp;
  });
}

export function pageList(current: number, total: number): Array<number | "…"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}
