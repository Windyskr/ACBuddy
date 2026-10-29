import { pageList } from "../lib/filters";

interface PaginationProps {
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}

const PAGE_SIZES = [20, 50, 100];

export default function Pagination({
  total,
  page,
  totalPages,
  pageSize,
  onPage,
  onPageSize,
}: PaginationProps) {
  if (total <= PAGE_SIZES[0]) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 text-sm text-slate-500">
      <select
        value={pageSize}
        onChange={(e) => onPageSize(Number(e.target.value))}
        className="mr-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 outline-none focus:border-brand-500"
        aria-label="每页条数"
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n} 条/页
          </option>
        ))}
      </select>

      {totalPages > 1 && (
        <>
          <PageButton disabled={page <= 1} onClick={() => onPage(page - 1)} ariaLabel="上一页">
            ‹
          </PageButton>

          {pageList(page, totalPages).map((p, i) =>
            p === "…" ? (
              <span key={`ellipsis-${i}`} className="px-1.5 text-slate-400">
                …
              </span>
            ) : (
              <PageButton key={p} active={p === page} onClick={() => onPage(p)} ariaLabel={`第 ${p} 页`}>
                {p}
              </PageButton>
            ),
          )}

          <PageButton disabled={page >= totalPages} onClick={() => onPage(page + 1)} ariaLabel="下一页">
            ›
          </PageButton>
        </>
      )}
    </div>
  );
}

function PageButton({
  children,
  onClick,
  active = false,
  disabled = false,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      className={`h-8 min-w-8 rounded-lg px-2 tabular-nums transition-colors ${
        active
          ? "bg-brand-600 font-medium text-white"
          : "text-slate-600 hover:bg-slate-200/70"
      } ${disabled ? "cursor-not-allowed opacity-40 hover:bg-transparent" : ""}`}
    >
      {children}
    </button>
  );
}
