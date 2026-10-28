import { useEffect, useRef, useState } from "react";
import type { ColumnKey, Difficulty, Filters } from "../types";
import { COLUMN_LABEL, DEFAULT_HIDDEN_COLUMNS, DIFFICULTY_LABEL, LOGIN_COLUMNS, MASTERY_LABEL } from "../lib/filters";
import { LEETCODE_SITE_LABEL, type LeetCodeSite } from "../lib/leetcode";

interface Stats {
  total: number;
  done: number;
  easy: number;
  medium: number;
  hard: number;
}

interface FilterBarProps {
  filters: Filters;
  tags: Array<[string, number]>;
  userTags: Array<[string, number]>;
  stats: Stats;
  authed: boolean;
  hiddenColumns: ColumnKey[];
  onToggleColumn: (key: ColumnKey) => void;
  leetcodeSite: LeetCodeSite;
  onLeetcodeSite: (site: LeetCodeSite) => void;
  onPatch: (patch: Partial<Filters>) => void;
  onReset: () => void;
}

function Dropdown({
  label,
  active,
  align = "left",
  title,
  children,
}: {
  label: React.ReactNode;
  active: boolean;
  align?: "left" | "right";
  title?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={title}
        className={`flex max-w-56 items-center gap-1 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
          active
            ? "border-blue-300 bg-blue-50 text-blue-700"
            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        }`}
      >
        <span className="flex min-w-0 items-center truncate">{label}</span>
        <svg
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className={`absolute ${align === "right" ? "right-0" : "left-0"} z-30 mt-1.5 w-44 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg`}>
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
    >
      {children}
      <span
        className={`ml-2 inline-block h-4 w-4 shrink-0 rounded border text-center text-xs leading-4 ${
          checked ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white"
        }`}
      >
        {checked ? "✓" : ""}
      </span>
    </button>
  );
}

function chipLabel(name: string, selected: string[]) {
  if (selected.length === 0) return name;
  return selected.length === 1 ? `${name}：${selected[0]}` : `${name} · ${selected.length}`;
}

function TagFilter({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: string;
  options: Array<[string, number]>;
  onChange: (value: string) => void;
}) {
  return (
    <Dropdown label={chipLabel(name, value ? [value] : [])} active={value !== ""}>
      <div className="max-h-64 w-40 overflow-y-auto">
        <MenuItem checked={value === ""} onClick={() => onChange("")}>
          全部{name}
        </MenuItem>
        {options.map(([tag, count]) => (
          <MenuItem key={tag} checked={value === tag} onClick={() => onChange(value === tag ? "" : tag)}>
            <span className="truncate">
              {tag}
              <span className="ml-1 text-xs text-slate-400">{count}</span>
            </span>
          </MenuItem>
        ))}
      </div>
    </Dropdown>
  );
}

const DIFFICULTIES: Difficulty[] = ["EASY", "MEDIUM", "HARD"];
const MASTERY_VALUES = [0, 1, 2, 3, 4, 5];
const RESULT_LABEL = { pass: "通过", fail: "解答错误", unattempted: "未做" } as const;

export default function FilterBar({
  filters,
  tags,
  userTags,
  stats,
  authed,
  hiddenColumns,
  onToggleColumn,
  leetcodeSite,
  onLeetcodeSite,
  onPatch,
  onReset,
}: FilterBarProps) {
  const filtersActive =
    filters.keyword !== "" ||
    filters.difficulties.length > 0 ||
    filters.mastery.length > 0 ||
    filters.latestResult !== "" ||
    filters.tag !== "" ||
    filters.userTag !== "";
  const columns = (Object.keys(COLUMN_LABEL) as ColumnKey[]).filter((key) => authed || !LOGIN_COLUMNS.includes(key));
  const columnsCustomized = columns.some((key) => hiddenColumns.includes(key) !== DEFAULT_HIDDEN_COLUMNS.includes(key));

  return (
    <section className="mb-3 mt-4 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <svg
            viewBox="0 0 20 20"
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 fill-slate-400"
            aria-hidden="true"
          >
            <path d="M8.5 3a5.5 5.5 0 1 0 3.38 9.84l3.64 3.64a1 1 0 0 0 1.41-1.41l-3.64-3.64A5.5 5.5 0 0 0 8.5 3zm0 2a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z" />
          </svg>
          <input
            type="search"
            value={filters.keyword}
            onChange={(e) => onPatch({ keyword: e.target.value })}
            placeholder="搜索题目名称或编号"
            aria-label="搜索题目"
            className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-blue-400"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Dropdown
          label={chipLabel("难度", filters.difficulties.map((d) => DIFFICULTY_LABEL[d]))}
          active={filters.difficulties.length > 0}
        >
          {DIFFICULTIES.map((d) => (
            <MenuItem
              key={d}
              checked={filters.difficulties.includes(d)}
              onClick={() =>
                onPatch({
                  difficulties: filters.difficulties.includes(d)
                    ? filters.difficulties.filter((x) => x !== d)
                    : [...filters.difficulties, d],
                })
              }
            >
              {DIFFICULTY_LABEL[d]}
            </MenuItem>
          ))}
        </Dropdown>

        <Dropdown
          label={chipLabel("掌握程度", filters.mastery.map((m) => MASTERY_LABEL[m] ?? String(m)))}
          active={filters.mastery.length > 0}
        >
          {MASTERY_VALUES.map((value) => (
            <MenuItem
              key={value}
              checked={filters.mastery.includes(value)}
              onClick={() =>
                onPatch({
                  mastery: filters.mastery.includes(value)
                    ? filters.mastery.filter((x) => x !== value)
                    : [...filters.mastery, value],
                })
              }
            >
              <span>
                <span className="tracking-tighter text-amber-400">{"★".repeat(value)}</span>
                <span className="tracking-tighter text-slate-200">{"★".repeat(5 - value)}</span>
                <span className="ml-1.5 text-slate-500">{MASTERY_LABEL[value]}</span>
              </span>
            </MenuItem>
          ))}
        </Dropdown>

        {authed && (
          <Dropdown
            label={chipLabel("最新结果", filters.latestResult ? [RESULT_LABEL[filters.latestResult]] : [])}
            active={filters.latestResult !== ""}
          >
            {(["", "pass", "fail", "unattempted"] as const).map((value) => (
              <MenuItem key={value || "all"} checked={filters.latestResult === value} onClick={() => onPatch({ latestResult: value })}>
                {value ? RESULT_LABEL[value] : "全部结果"}
              </MenuItem>
            ))}
          </Dropdown>
        )}

        <TagFilter name="标签" value={filters.tag} options={tags} onChange={(tag) => onPatch({ tag })} />

        {authed && (userTags.length > 0 || filters.userTag !== "") && (
          <TagFilter name="个人标签" value={filters.userTag} options={userTags} onChange={(userTag) => onPatch({ userTag })} />
        )}

        {filtersActive && (
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-200/60 hover:text-slate-700"
          >
            清除筛选
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span
            className="whitespace-nowrap text-sm tabular-nums text-slate-500"
            title={`已完成：简单 ${stats.easy} · 中等 ${stats.medium} · 困难 ${stats.hard}（有 AC 记录或掌握程度拉满）`}
          >
            {stats.total} 题 · 已完成 <span className="font-semibold text-blue-600">{stats.done}</span>
          </span>
          <Dropdown
            label={
              <>
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <rect x="3" y="4" width="14" height="12" rx="2" />
                  <path d="M8 4v12M12 4v12" />
                </svg>
                <span className="sr-only">显示设置</span>
              </>
            }
            title="显示设置"
            active={columnsCustomized}
            align="right"
          >
            <p className="px-2.5 pb-0.5 pt-1 text-xs text-slate-400">显示列</p>
            {columns.map((key) => (
              <MenuItem key={key} checked={!hiddenColumns.includes(key)} onClick={() => onToggleColumn(key)}>
                {COLUMN_LABEL[key]}
              </MenuItem>
            ))}
            <p className="mt-1 border-t border-slate-100 px-2.5 pb-0.5 pt-2 text-xs text-slate-400">力扣题目链接</p>
            {(Object.keys(LEETCODE_SITE_LABEL) as LeetCodeSite[]).map((site) => (
              <MenuItem key={site} checked={leetcodeSite === site} onClick={() => onLeetcodeSite(site)}>
                {LEETCODE_SITE_LABEL[site]}
              </MenuItem>
            ))}
          </Dropdown>
        </div>
      </div>
    </section>
  );
}
