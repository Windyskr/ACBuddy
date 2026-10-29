import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ColumnKey,
  Difficulty,
  Problem,
  ProgressView,
  ProgressViewMap,
  ServerProgress,
  SortKey,
  SortState,
  TableColumnKey,
} from "../types";
import { renderMarkdown } from "../lib/markdown";
import { useLocalStorage } from "../lib/storage";
import AttemptTimeline from "./AttemptTimeline";
import { problemUrl, type LeetCodeSite } from "../lib/leetcode";
import {
  DIFFICULTY_LABEL,
  LOGIN_COLUMNS,
  MASTERY_LABEL,
  viewOf,
} from "../lib/filters";

interface ProblemTableProps {
  items: Problem[];
  sort: SortState;
  hiddenColumns: ColumnKey[];
  leetcodeSite: LeetCodeSite;
  views: ProgressViewMap;
  authed: boolean;
  onSort: (key: SortKey) => void;
  onMastery: (slug: string, value: number) => void;
  onUrgency: (slug: string, value: number) => void;
  onSaveNote: (slug: string, text: string) => void;
  onTags: (slug: string, tags: string[]) => void;
  onProgressChange: (slug: string, progress: ServerProgress | null) => void;
  onLogin: () => void;
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

const BADGE: Record<Difficulty, string> = {
  EASY: "bg-brand-50 text-brand-700",
  MEDIUM: "bg-amber-50 text-amber-600",
  HARD: "bg-rose-50 text-rose-600",
};

const ALL_COLUMNS: TableColumnKey[] = [
  "problem",
  "urgency",
  "difficulty",
  "tags",
  "recent",
  "mastery",
  "userTags",
];

const COLUMN_WIDTH: Record<TableColumnKey, { initial: number; min: number; max: number }> = {
  problem: { initial: 240, min: 140, max: 560 },
  urgency: { initial: 64, min: 56, max: 120 },
  difficulty: { initial: 64, min: 56, max: 130 },
  tags: { initial: 180, min: 80, max: 480 },
  recent: { initial: 104, min: 88, max: 200 },
  mastery: { initial: 120, min: 104, max: 190 },
  userTags: { initial: 150, min: 72, max: 320 },
};

const COLUMN_LABEL: Record<TableColumnKey, string> = {
  problem: "题目",
  urgency: "紧急",
  difficulty: "难度",
  tags: "标签",
  recent: "最近作答",
  mastery: "掌握程度",
  userTags: "个人标签",
};

const COLUMN_SORT: Partial<Record<TableColumnKey, SortKey>> = {
  difficulty: "difficulty",
  recent: "lastAttempt",
  mastery: "mastery",
};

function normalizeColumnOrder(value: TableColumnKey[]): TableColumnKey[] {
  const valid = new Set<TableColumnKey>(ALL_COLUMNS);
  const normalized = value.filter((key, index) => valid.has(key) && value.indexOf(key) === index);
  ALL_COLUMNS.forEach((key, i) => {
    if (!normalized.includes(key)) normalized.splice(i === 0 ? 0 : normalized.indexOf(ALL_COLUMNS[i - 1]) + 1, 0, key);
  });
  return normalized;
}

function UserTagsCell({
  tags,
  authed,
  onChange,
}: {
  tags: string[];
  authed: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function addTag() {
    const tag = inputRef.current?.value.trim() ?? "";
    if (!tag || tags.includes(tag)) {
      setEditing(false);
      return;
    }
    onChange([...tags, tag]);
    setEditing(false);
  }

  return (
    <td className="cursor-default px-2 py-2.5" data-no-row-toggle>
      <div className="flex w-full flex-wrap items-center gap-1 overflow-hidden">
        {tags.map((tag) => (
          <span key={tag} className="inline-flex max-w-28 items-center gap-0.5 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">
            <span className="truncate" title={tag}>{tag}</span>
            {authed && (
              <button
                type="button"
                className="text-brand-500 hover:text-rose-500"
                onClick={() => onChange(tags.filter((item) => item !== tag))}
                aria-label={`删除标签 ${tag}`}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {editing ? (
          <input
            ref={inputRef}
            autoFocus
            maxLength={20}
            placeholder="输入标签"
            className="w-20 rounded border border-brand-300 px-1.5 py-0.5 text-xs outline-none focus:border-brand-500"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTag();
              } else if (event.key === "Escape") {
                setEditing(false);
              }
            }}
          />
        ) : tags.length < 10 ? (
          <button
            type="button"
            className="row-reveal rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-brand-50 hover:text-brand-700"
            onClick={() => {
              if (authed) setEditing(true);
              else onChange(tags);
            }}
            aria-label="添加个人标签"
            title={authed ? "添加个人标签" : "登录后添加个人标签"}
          >
            +
          </button>
        ) : null}
      </div>
    </td>
  );
}

export default function ProblemTable({
  items,
  sort,
  hiddenColumns,
  leetcodeSite,
  views,
  authed,
  onSort,
  onMastery,
  onUrgency,
  onSaveNote,
  onTags,
  onProgressChange,
  onLogin,
}: ProblemTableProps) {
  const [openNotes, setOpenNotes] = useState<Set<string>>(() => new Set());
  const [storedColumnOrder, setStoredColumnOrder] = useLocalStorage<TableColumnKey[]>(
    "acb.table.columnOrder.v1",
    ALL_COLUMNS,
  );
  const [columnWidths, setColumnWidths] = useLocalStorage<Partial<Record<TableColumnKey, number>>>(
    "acb.table.columnWidths.v1",
    {},
  );
  const [draggingColumn, setDraggingColumn] = useState<TableColumnKey | null>(null);
  const [resizingColumn, setResizingColumn] = useState<TableColumnKey | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const ignoreSortClickRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const colHidden = (key: ColumnKey) => hiddenColumns.includes(key);
  const columnOrder = useMemo(() => normalizeColumnOrder(storedColumnOrder), [storedColumnOrder]);
  const visibleColumns = useMemo(
    () => columnOrder.filter((key) => key === "problem" || (!colHidden(key) && (authed || !LOGIN_COLUMNS.includes(key)))),
    [columnOrder, hiddenColumns, authed],
  );
  const widthFor = (key: TableColumnKey) => {
    const limits = COLUMN_WIDTH[key];
    return Math.min(Math.max(columnWidths[key] ?? limits.initial, limits.min), limits.max);
  };
  const tableWidth = visibleColumns.reduce((total, key) => total + widthFor(key), 0);
  const renderedTableWidth = Math.max(tableWidth, Math.floor(containerWidth));
  const flexibleProblemWidth = widthFor("problem") + Math.max(0, renderedTableWidth - tableWidth);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  function reorderColumn(source: TableColumnKey, target: TableColumnKey) {
    if (source === target) return;
    const next = [...columnOrder];
    const sourceIndex = next.indexOf(source);
    const targetIndex = next.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    setStoredColumnOrder(next);
  }

  function startResize(key: TableColumnKey, event: React.PointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widthFor(key);
    const limits = COLUMN_WIDTH[key];
    resizeCleanupRef.current?.();
    setResizingColumn(key);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: PointerEvent) => {
      const width = Math.min(Math.max(startWidth + moveEvent.clientX - startX, limits.min), limits.max);
      setColumnWidths((current) => ({ ...current, [key]: Math.round(width) }));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      resizeCleanupRef.current = null;
      setResizingColumn(null);
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  function renderHeader(key: TableColumnKey) {
    const sortKey = COLUMN_SORT[key];
    const active = sortKey !== undefined && sort.key === sortKey;
    return (
      <th
        key={key}
        draggable={resizingColumn === null}
        onDragStart={(event) => {
          ignoreSortClickRef.current = true;
          setDraggingColumn(key);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", key);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const source = event.dataTransfer.getData("text/plain") as TableColumnKey;
          if (ALL_COLUMNS.includes(source)) reorderColumn(source, key);
          setDraggingColumn(null);
        }}
        onDragEnd={() => {
          setDraggingColumn(null);
          window.setTimeout(() => {
            ignoreSortClickRef.current = false;
          }, 0);
        }}
        className={`group relative overflow-hidden bg-slate-50 px-2 py-2.5 text-left text-xs font-semibold text-slate-500 ${draggingColumn === key ? "opacity-40" : ""}`}
        title="拖动表头调整顺序，拖动右侧边缘调整宽度"
      >
        {sortKey ? (
          <button
            type="button"
            onClick={() => {
              if (!ignoreSortClickRef.current) onSort(sortKey);
            }}
            className={`inline-flex max-w-full items-center gap-1 truncate hover:text-brand-700 ${active ? "text-brand-700" : ""}`}
          >
            <span className="truncate">{COLUMN_LABEL[key]}</span>
            <span className={`shrink-0 ${active ? "" : "text-slate-300"}`}>
              {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
            </span>
          </button>
        ) : (
          <span className="block truncate">{COLUMN_LABEL[key]}</span>
        )}
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={`调整${COLUMN_LABEL[key]}列宽`}
          onPointerDown={(event) => startResize(key, event)}
          onDoubleClick={() => {
            setColumnWidths((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
          }}
          onDragStart={(event) => event.preventDefault()}
          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none border-r border-transparent hover:border-brand-400 group-hover:bg-brand-100/40"
          title="拖动调整列宽，双击恢复默认宽度"
        />
      </th>
    );
  }

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-keep-open]")) return;
      setOpenNotes(new Set());
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <table className="table-fixed border-collapse text-sm" style={{ width: renderedTableWidth }}>
        <colgroup>
          {visibleColumns.map((key) => (
            <col key={key} style={{ width: key === "problem" ? flexibleProblemWidth : widthFor(key) }} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-slate-200">
            {visibleColumns.map(renderHeader)}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={visibleColumns.length} className="px-4 py-16 text-center text-sm text-slate-400">
                没有找到符合条件的题目，试试调整筛选条件
              </td>
            </tr>
          )}

          {items.map((p) => (
            <FragmentRow
              key={p.slug}
              problem={p}
              view={viewOf(views, p.slug)}
              leetcodeSite={leetcodeSite}
              noteOpen={openNotes.has(p.slug)}
              authed={authed}
              onMastery={(v) => onMastery(p.slug, v)}
              onUrgency={(v) => onUrgency(p.slug, v)}
              onToggleNote={() => {
                setOpenNotes((current) => {
                  const next = new Set(current);
                  if (next.has(p.slug)) next.delete(p.slug);
                  else next.add(p.slug);
                  return next;
                });
              }}
              onSaveNote={(text) => onSaveNote(p.slug, text)}
              onTags={(tags) => onTags(p.slug, tags)}
              onProgressChange={onProgressChange}
              onLogin={onLogin}
              columns={visibleColumns}
              panelWidth={containerWidth}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  problem: Problem;
  columns: TableColumnKey[];
  view: ProgressView;
  leetcodeSite: LeetCodeSite;
  noteOpen: boolean;
  authed: boolean;
  onMastery: (value: number) => void;
  onUrgency: (value: number) => void;
  onToggleNote: () => void;
  onSaveNote: (text: string) => void;
  onTags: (tags: string[]) => void;
  onProgressChange: (slug: string, progress: ServerProgress | null) => void;
  onLogin: () => void;
  panelWidth: number;
}

function FragmentRow({
  problem: p,
  columns,
  view,
  leetcodeSite,
  noteOpen,
  authed,
  onMastery,
  onUrgency,
  onToggleNote,
  onSaveNote,
  onTags,
  onProgressChange,
  onLogin,
  panelWidth,
}: RowProps) {
  const { mastery: masteryValue, urgency: urgencyValue, lastResult, lastAttemptAt, note: noteText, tags: userTags, done: isDone } = view;
  const colSpan = columns.length;
  function handleRowClick(e: React.MouseEvent<HTMLTableRowElement>) {
    const t = e.target;
    if (t instanceof Element && t.closest("a, button, input, [data-no-row-toggle]")) return;
    onToggleNote();
  }

  const noteAreaRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (noteOpen) setEditing(!noteText);
  }, [noteOpen]);

  function saveNote() {
    const text = noteAreaRef.current?.value ?? "";
    onSaveNote(text);
    if (text.trim()) {
      setEditing(false);
    } else {
      onToggleNote();
    }
  }

  function cancelEdit() {
    if (noteText) setEditing(false);
    else onToggleNote();
  }

  function renderCell(column: TableColumnKey) {
    switch (column) {
      case "problem":
        return (
          <td key={column} className="overflow-hidden px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-1">
              <a
                href={problemUrl(p, leetcodeSite)}
                target="_blank"
                rel="noreferrer"
                className={`min-w-0 truncate font-medium hover:text-brand-700 hover:underline underline-offset-2 ${isDone ? "text-slate-400 line-through decoration-slate-300" : "text-slate-800"}`}
                title={columns.includes("tags") ? p.title : `${p.title}\n${p.tags.join("、")}`}
              >
                {p.id && <span className="mr-1 text-slate-400">{p.id}.</span>}
                {p.title}
              </a>
              <button
                type="button"
                onClick={onToggleNote}
                aria-expanded={noteOpen}
                aria-label="笔记"
                title={noteText ? "查看笔记" : "写笔记"}
                className={`shrink-0 rounded p-0.5 hover:bg-brand-50 hover:text-brand-700 ${noteText || noteOpen ? "text-brand-600" : "row-reveal text-slate-400"}`}
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M5.5 3.5h6l3 3v10h-9z" strokeLinejoin="round" />
                  <path d="M8 10h4.5M8 13h4.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </td>
        );
      case "urgency":
        return (
          <td key={column} className="cursor-default overflow-hidden px-2 py-2.5">
            <div className={`flex items-center gap-[0.3125rem] ${urgencyValue ? "" : "row-reveal"}`} role="group" aria-label={`紧急程度：${p.title}`}>
              {[1, 2, 3].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onUrgency(value === urgencyValue ? 0 : value)}
                  className={`text-lg font-bold leading-none transition-colors ${value <= urgencyValue ? "text-rose-500 hover:text-rose-600" : "text-slate-200 hover:text-rose-200"}`}
                  aria-label={`设为${value}级紧急`}
                  title={`${value}级紧急`}
                >
                  !
                </button>
              ))}
            </div>
          </td>
        );
      case "difficulty":
        return (
          <td key={column} className="overflow-hidden px-2 py-2.5">
            <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${BADGE[p.difficulty]}`}>
              {DIFFICULTY_LABEL[p.difficulty]}
            </span>
          </td>
        );
      case "tags":
        return (
          <td key={column} className="overflow-hidden truncate px-2 py-2.5 text-slate-500" title={p.tags.join("、")}>
            {p.tags.join("、")}
          </td>
        );
      case "recent":
        return (
          <td
            key={column}
            className="overflow-hidden truncate px-2 py-2.5 tabular-nums"
            title={lastAttemptAt ? `${lastResult === "pass" ? "通过" : "未通过"} · ${formatTime(lastAttemptAt)}` : undefined}
          >
            {lastAttemptAt && (
              <>
                <span className={lastResult === "pass" ? "text-brand-700" : "text-rose-600"}>
                  {lastResult === "pass" ? "✓" : "✗"}
                </span>
                <span className="ml-1.5 text-slate-500">{formatDay(lastAttemptAt)}</span>
              </>
            )}
          </td>
        );
      case "mastery":
        return (
          <td key={column} className="cursor-default overflow-hidden px-2 py-2.5">
            <div className={`flex items-center gap-[0.175rem] ${masteryValue ? "" : "row-reveal"}`} role="group" aria-label={`掌握程度：${p.title}`}>
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onMastery(value === masteryValue ? 0 : value)}
                  className={`text-lg leading-none transition-colors ${value <= masteryValue ? "text-amber-400 hover:text-amber-500" : "text-slate-200 hover:text-amber-200"}`}
                  aria-label={`设为${value}颗星`}
                  title={`${value}颗星：${MASTERY_LABEL[value]}`}
                >
                  ★
                </button>
              ))}
            </div>
          </td>
        );
      case "userTags":
        return <UserTagsCell key={column} tags={userTags} authed={authed} onChange={onTags} />;
    }
  }

  return (
    <>
      <tr
        onClick={handleRowClick}
        data-keep-open
        data-open={noteOpen ? "" : undefined}
        className={`cursor-pointer border-b border-slate-100 transition-colors hover:bg-brand-50/60 ${isDone ? "bg-slate-50/60" : ""}`}
      >
        {columns.map(renderCell)}
      </tr>

      {noteOpen && (
        <tr className="border-b border-slate-100">
          <td colSpan={colSpan} data-keep-open className="bg-slate-50/80 px-4 py-3">
            <div className="sticky left-4 flex items-start gap-2" style={panelWidth ? { width: panelWidth - 32 } : undefined}>
              <div className="min-w-0 flex-1">
                {editing ? (
                  <textarea
                    ref={noteAreaRef}
                    autoFocus
                    defaultValue={noteText}
                    placeholder="记录解题思路，支持 Markdown（# 标题、**加粗**、- 列表、`代码`），Ctrl+Enter 保存"
                    rows={4}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        saveNote();
                      }
                    }}
                    className="min-w-0 w-full rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-brand-500"
                  />
                ) : noteText ? (
                  <div
                    className="md-content min-h-[38px] rounded-lg border border-slate-200 bg-white p-2.5 text-sm"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(noteText) }}
                  />
                ) : (
                  <p className="rounded-lg border border-dashed border-slate-200 bg-white p-2.5 text-xs text-slate-400">
                    还没有笔记，点「编辑」写下这道题的思路吧
                  </p>
                )}
                <AttemptTimeline slug={p.slug} leetcodeSite={leetcodeSite} authed={authed} onProgressChange={onProgressChange} onLogin={onLogin} />
              </div>
              <div className="flex shrink-0 flex-col gap-1.5">
                {editing ? (
                  <>
                    <button
                      type="button"
                      onClick={saveNote}
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50"
                  >
                    编辑
                  </button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
