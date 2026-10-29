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

function navLinkClass(active: boolean) {
  return `rounded-lg px-2 py-1.5 text-sm font-medium sm:px-2.5 ${
    active ? "bg-blue-50 text-blue-600" : "text-slate-600 hover:bg-slate-100 hover:text-slate-800"
  }`;
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
            className={`hidden sm:block ${navLinkClass(!installPage)}`}
          >
            题目列表
          </a>
          <a
            href="/install"
            aria-current={installPage ? "page" : undefined}
            className={`shrink-0 ${navLinkClass(installPage)}`}
          >
            安装插件
          </a>
          <a
            href="https://github.com/Windyskr/acbuddy"
            target="_blank"
            rel="noreferrer"
            title="ACBuddy 是开源项目，源代码在 GitHub"
            className={`flex shrink-0 items-center gap-1.5 ${navLinkClass(false)}`}
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
              <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
            </svg>
            <span className="sr-only sm:not-sr-only">开源</span>
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
