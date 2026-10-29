/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 自建部署用自己的 Turnstile 站点密钥 */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
