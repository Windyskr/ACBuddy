// Cloudflare Turnstile：登录、注册前的人机验证。站点密钥是公开的，自建部署构建时用 VITE_TURNSTILE_SITE_KEY 换成自己的
export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "0x4AAAAAAFq-8lA1nNAK4OlE";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export interface TurnstileOptions {
  sitekey: string;
  action?: string;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "flexible" | "compact";
  language?: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: (code: string) => void;
}

export interface Turnstile {
  render(container: HTMLElement, options: TurnstileOptions): string | null | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

/** 用到时才加载 api.js；加载失败（比如连不上 Cloudflare）就撤掉脚本，下次再试 */
export function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    const failed = () => {
      script.remove();
      loading = null;
      reject(new Error("Turnstile 加载失败"));
    };
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : failed());
    script.onerror = failed;
    document.head.append(script);
  });
  return loading;
}
