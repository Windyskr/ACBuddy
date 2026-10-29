import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../types";
import { api } from "../lib/api";
import { TURNSTILE_SITE_KEY, loadTurnstile, type Turnstile } from "../lib/turnstile";

interface AuthModalProps {
  onClose: () => void;
  onSuccess: (user: AuthUser) => void;
}

type Mode = "login" | "register";

export default function AuthModal({ onClose, onSuccess }: AuthModalProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const captchaRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<{ turnstile: Turnstile; id: string } | null>(null);

  // 登录、注册都要人机验证；action 在渲染时定死，切换页签就换一个小组件
  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(
      (turnstile) => {
        if (cancelled || !captchaRef.current) return;
        const id = turnstile.render(captchaRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action: mode === "register" ? "signup" : "login",
          theme: "light",
          size: "flexible",
          language: "zh-CN",
          callback: setCaptchaToken,
          "expired-callback": () => setCaptchaToken(""),
          "error-callback": () => setCaptchaToken(""),
        });
        if (id) widgetRef.current = { turnstile, id };
      },
      () => {
        if (!cancelled) setCaptchaFailed(true);
      },
    );
    return () => {
      cancelled = true;
      const widget = widgetRef.current;
      widgetRef.current = null;
      try {
        widget?.turnstile.remove(widget.id);
      } catch {
      }
      setCaptchaToken("");
      setCaptchaFailed(false);
    };
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !captchaToken) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ user: AuthUser }>(`/auth/${mode}`, {
        method: "POST",
        body: { username: username.trim(), password, turnstileToken: captchaToken },
      });
      onSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
      // 令牌只能核验一次，失败后换一个新的才能重试
      const widget = widgetRef.current;
      if (widget) {
        setCaptchaToken("");
        widget.turnstile.reset(widget.id);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">
            {mode === "login" ? "登录 ACBuddy" : "注册新账号"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 grid grid-cols-2 rounded-xl bg-slate-100 p-1 text-sm">
          {(["login", "register"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`rounded-lg py-1.5 font-medium transition-colors ${
                mode === m ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {m === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="auth-username" className="mb-1 block text-xs font-medium text-slate-500">
              用户名（3-24 位字母/数字/_/-）
            </label>
            <input
              id="auth-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          </div>
          <div>
            <label htmlFor="auth-password" className="mb-1 block text-xs font-medium text-slate-500">
              密码（至少 8 位）
            </label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          </div>

          <div ref={captchaRef} className="min-h-[65px]" />

          {captchaFailed && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">人机验证加载失败，请检查网络后刷新页面</p>
          )}
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}

          <button
            type="submit"
            disabled={busy || !captchaToken}
            className="w-full rounded-xl bg-brand-600 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>

        <p className="mt-3 text-center text-xs text-slate-400">
          登录后，浏览器插件会自动同步本站登录状态
        </p>
      </div>
    </div>
  );
}
