import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../types";

interface HeaderProps {
  user: AuthUser | null;
  installPage?: boolean;
  onLoginClick: () => void;
  onPasswordChange: () => void;
  onLogout: () => void;
}

function AccountMenu({ username, onPasswordChange, onLogout }: {
  username: string;
  onPasswordChange: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "block w-full rounded-lg px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="已登录，浏览器插件会同步此登录状态"
        className="flex max-w-24 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:max-w-48 sm:px-2.5"
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
        <span className="truncate">{username}</span>
        <svg viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-1.5 w-36 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onPasswordChange(); }}>
            修改密码
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onLogout(); }}>
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}

export default function Header({ user, installPage = false, onLoginClick, onPasswordChange, onLogout }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 px-4">
        <a href="/" className="flex shrink-0 items-center gap-1.5 text-base font-bold text-slate-800 sm:text-lg">
          <img src="/favicon.png" alt="" className="h-7 w-7 sm:h-8 sm:w-8" />
          ACBuddy
        </a>

        <nav aria-label="主导航" className="flex min-w-0 items-center gap-1 sm:gap-3">
          <a
            href="/"
            aria-current={installPage ? undefined : "page"}
            className={`hidden rounded-lg px-2.5 py-1.5 text-sm font-medium sm:block ${installPage ? "text-slate-500 hover:bg-slate-50 hover:text-slate-700" : "text-blue-600"}`}
          >
            题目列表
          </a>
          <a
            href="/install"
            aria-current={installPage ? "page" : undefined}
            className={`shrink-0 rounded-lg px-2 py-1.5 text-sm font-medium sm:px-2.5 ${installPage ? "bg-blue-50 text-blue-600" : "text-slate-600 hover:bg-slate-100 hover:text-blue-600"}`}
          >
            安装插件
          </a>
          {user ? (
            <AccountMenu username={user.username} onPasswordChange={onPasswordChange} onLogout={onLogout} />
          ) : (
            <button
              type="button"
              onClick={onLoginClick}
              className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              登录
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
