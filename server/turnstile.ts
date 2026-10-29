/// <reference types="@cloudflare/workers-types" />

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResult {
  success?: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
}

/**
 * 向 Cloudflare 核验 Turnstile 令牌：必须成功、action 对得上、由允许的前端域名签发才算通过。
 * 令牌 5 分钟过期、只能核验一次（重放返回 timeout-or-duplicate）；没配密钥或网络出错一律按未通过处理。
 */
export async function verifyTurnstile(options: {
  secret: string | undefined;
  token: unknown;
  action: string;
  hostnames: Set<string>;
  remoteip?: string;
}): Promise<boolean> {
  const { secret, token, action, hostnames, remoteip } = options;
  if (!secret) {
    console.error("[turnstile] TURNSTILE_SECRET 未配置");
    return false;
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 2048 || hostnames.size === 0) {
    return false;
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteip) body.set("remoteip", remoteip);
  let result: SiteverifyResult;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body,
    });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    result = await res.json();
  } catch (error) {
    console.error("[turnstile] siteverify failed", error);
    return false;
  }

  if (!result.success || result.action !== action || !hostnames.has(result.hostname ?? "")) {
    console.warn("[turnstile] rejected", result["error-codes"], result.action, result.hostname);
    return false;
  }
  return true;
}
