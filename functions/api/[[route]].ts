/// <reference types="@cloudflare/workers-types" />
/**
 * 响应包络：成功 { ok: true, data }，失败 { ok: false, error: "中文说明" } + 4xx/5xx。
 * 时间字段一律 ISO 8601 UTC（isoUtc）。
 *
 * 题目用 (platform, slug) 标识，已接入的平台见 PLATFORMS；作答记录另记提交站点 site。
 * 力扣国内版、国际版同属 leetcode：slug 相同，同一道题共用进度，site 区分 leetcode.cn / leetcode.com。
 * - GET    /api/progress?platform=leetcode    该平台的全部题目进度
 * - GET    /api/progress/:platform/:slug      单题进度 + 最近 20 条作答
 * - PUT    /api/progress/:platform/:slug      改笔记 / 掌握程度 / 紧急程度 / 标签 / 通过状态
 * - DELETE /api/progress/:platform/:slug      清空单题进度与作答
 * - POST   /api/attempts                      上报一次作答（带 site，服务端据此推出 platform）
 * - GET    /api/attempts?limit=50             最近作答
 * - PUT / DELETE /api/attempts/:id           补写心得 / 删除一条作答
 *
 * 两种笔记，互不同步：
 * - progress.note：题目当前笔记，只由 PUT /api/progress/:platform/:slug 修改（"" 表示清除）
 * - attempts.note：某次作答的心得，POST /api/attempts 时可带，之后用 PUT /api/attempts/:id 补写
 * 两者都按简单 Markdown 渲染，网站渲染时已做 HTML 转义。
 *
 * progress.done = 有过 AC 记录，由作答流水重算（PUT 也可显式改）。mastery 0-5，urgency 0-3。
 *
 * 认证（二选一，progress/attempts 接口通用）：
 * 1. 会话 Cookie acb_session（网页登录 / 扩展 credentials:include 同步登录态）
 * 2. Authorization: Bearer <api_key>（程序化调用）
 *
 * 注册、登录（POST /api/auth/register、/api/auth/login {username, password, turnstileToken}）：
 * turnstileToken 来自网页上的 Cloudflare Turnstile 小组件（action 分别是 "signup"、"login"），
 * 服务端核验通过才继续，令牌只能用一次。
 */
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  burnPasswordTime,
  generateApiKey,
  generateSessionToken,
  hashPassword,
  readSessionToken,
  sessionCookie,
  sha256Hex,
  verifyPassword,
} from "../../server/auth";
import { verifyTurnstile } from "../../server/turnstile";

interface Env {
  DB: D1Database;
  SITE_ORIGIN?: string;
  ALLOW_DEV_ORIGINS?: string;
  EXTENSION_IDS?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string;
}

interface UserRow {
  id: number;
  username: string;
}

interface ProgressRow {
  platform: string;
  slug: string;
  title: string | null;
  difficulty: string | null;
  done: number;
  mastery: number;
  urgency: number;
  tags: string;
  note: string | null;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  total_time_ms: number;
  attempt_count: number;
  last_result: "pass" | "fail" | null;
}

const PROGRESS_SELECT = "SELECT * FROM progress p";
const LATEST_RESULT_SUBQUERY = `(
  SELECT a.result FROM attempts a
  WHERE a.user_id = ?1 AND a.platform = ?2 AND a.slug = ?3 ORDER BY a.id DESC LIMIT 1
)`;
const ATTEMPT_COLUMNS = `id, platform, slug, site, result, verdict, time_ms AS timeMs, language,
  submission_id AS submissionId, note, created_at AS createdAt`;

const DEFAULT_SITE_ORIGIN = "https://acbuddy.pages.dev";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Max-Age": "86400",
};

function isAllowedOrigin(origin: string, env: Env): boolean {
  if (origin === (env.SITE_ORIGIN ?? DEFAULT_SITE_ORIGIN)) return true;

  // Cookie 是 SameSite=None，凡是进了这个白名单的来源都能以用户身份读写全部数据。
  if (env.ALLOW_DEV_ORIGINS === "1" || env.ALLOW_DEV_ORIGINS === "true") {
    try {
      const url = new URL(origin);
      if (
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }

  const configured = (env.EXTENSION_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return configured.some((id) => origin === `chrome-extension://${id}`);
  }
  // 未配置 EXTENSION_IDS 时放行任意已安装扩展（都能以用户身份调用本 API），生产应设置
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

/** 允许签发 Turnstile 令牌的前端域名：默认只有 SITE_ORIGIN 的域名，本地开发在 .dev.vars 里另设 */
function turnstileHostnames(env: Env): Set<string> {
  const configured = (env.TURNSTILE_HOSTNAMES ?? "")
    .split(",")
    .map((hostname) => hostname.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : [new URL(env.SITE_ORIGIN ?? DEFAULT_SITE_ORIGIN).hostname]);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const headers = { ...CORS_HEADERS };
  if (origin && isAllowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function json(data: unknown, request: Request, env: Env, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

function fail(status: number, error: string, request: Request, env: Env): Response {
  return json({ ok: false, error }, request, env, status);
}

function serializeProgress(row: ProgressRow) {
  return {
    platform: row.platform,
    slug: row.slug,
    title: row.title,
    difficulty: row.difficulty,
    done: row.done === 1,
    mastery: row.mastery,
    urgency: row.urgency,
    tags: parseStoredTags(row.tags),
    note: row.note ?? "",
    firstAttemptAt: isoUtc(row.first_attempt_at),
    lastAttemptAt: isoUtc(row.last_attempt_at),
    totalTimeMs: row.total_time_ms,
    attemptCount: row.attempt_count,
    lastResult: row.last_result,
  };
}

function parseStoredTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function isoUtc(sqliteTime: string | null): string | null {
  if (!sqliteTime) return null;
  const normalized = sqliteTime.trim().replace(" ", "T");
  return normalized.endsWith("Z") ? normalized : `${normalized}Z`;
}

interface AttemptRow {
  id: number;
  platform: string;
  slug: string;
  site: string;
  result: "pass" | "fail";
  verdict: string | null;
  timeMs: number | null;
  language: string | null;
  submissionId: string | null;
  note: string | null;
  createdAt: string | null;
}

function serializeAttempts(rows: Array<Omit<AttemptRow, "createdAt"> & { createdAt: string | null }>): AttemptRow[] {
  return rows.map((row) => ({ ...row, createdAt: isoUtc(row.createdAt) }));
}

const MAX_BODY_BYTES = 256 * 1024;

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const body = JSON.parse(text) as unknown;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

const MAX_NOTE_LENGTH = 20_000;

function parseNote(value: unknown): string | null | false {
  if (value === undefined) return null;
  if (typeof value !== "string") return false;
  if (value.length > MAX_NOTE_LENGTH) return false;
  return value === "" ? null : value;
}

function optionalText(value: unknown, max: number): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) return false;
  return value.trim() || null;
}

const PLATFORMS = new Map<string, { slug: RegExp; sites: string[] }>([
  ["leetcode", { slug: /^[a-z0-9][a-z0-9-]{0,119}$/i, sites: ["leetcode.cn", "leetcode.com"] }],
]);
const SITE_PLATFORM = new Map(
  [...PLATFORMS].flatMap(([platform, { sites }]) => sites.map((site): [string, string] => [site, platform])),
);
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
const MAX_TIME_MS = 86_400_000;

interface RateRule {
  limit: number;
  windowSec: number;
}

const RATE_LIMITS = {
  register: { limit: 5, windowSec: 3600 } satisfies RateRule,
  loginByIp: { limit: 12, windowSec: 600 } satisfies RateRule,
  loginByUser: { limit: 8, windowSec: 600 } satisfies RateRule,
  password: { limit: 10, windowSec: 600 } satisfies RateRule,
  write: { limit: 1200, windowSec: 3600 } satisfies RateRule,
};

function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** 单条 UPSERT + RETURNING 原子累加，窗口过期时就地重置，不需要先读后写 */
async function enforceRateLimit(
  env: Env,
  bucket: string,
  rule: RateRule,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowFloor = now - rule.windowSec;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, hits, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET
         hits = CASE WHEN rate_limits.window_start <= ?3 THEN 1 ELSE rate_limits.hits + 1 END,
         window_start = CASE WHEN rate_limits.window_start <= ?3 THEN ?2 ELSE rate_limits.window_start END
       RETURNING hits, window_start`,
    )
      .bind(bucket, now, windowFloor)
      .first<{ hits: number; window_start: number }>();
    if (!row) return { allowed: true, retryAfter: 0 };
    const allowed = row.hits <= rule.limit;
    return {
      allowed,
      retryAfter: allowed ? 0 : Math.max(1, row.window_start + rule.windowSec - now),
    };
  } catch {
    // 限流表不可用时不阻断正常请求（宁可放行也不要整站 500）
    return { allowed: true, retryAfter: 0 };
  }
}

function sweepRateLimits(env: Env, ctx: ExecutionContext): void {
  if (Math.random() >= 0.01) return;
  ctx.waitUntil(
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1")
      .bind(Math.floor(Date.now() / 1000) - 86_400)
      .run()
      .then(
        () => undefined,
        () => undefined,
      ),
  );
}

function rateLimited(retryAfter: number, request: Request, env: Env): Response {
  const res = fail(429, `请求过于频繁，请在 ${retryAfter} 秒后重试`, request, env);
  res.headers.set("Retry-After", String(retryAfter));
  return res;
}

const QUOTAS = {
  progressRows: 4000,
  attemptRows: 20_000,
};

/** 用 `LIMIT ?` 子查询把读取行数卡在上限 +1，避免 COUNT(*) 扫全部行（D1 按读取行数计费） */
async function isOverQuota(
  env: Env,
  table: "progress" | "attempts",
  userId: number,
  max: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE user_id = ?1 LIMIT ?2)`,
  )
    .bind(userId, max + 1)
    .first<{ n: number }>();
  return (row?.n ?? 0) > max;
}

async function createSession(env: Env, userId: number): Promise<string> {
  const token = generateSessionToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')"),
    env.DB
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at)
         VALUES (?1, ?2, datetime('now', '+${SESSION_TTL_DAYS} days'))`,
      )
      .bind(await sha256Hex(token), userId),
  ]);
  return sessionCookie(token);
}

async function resolveUser(env: Env, request: Request): Promise<UserRow | null> {
  const token = readSessionToken(request);
  if (token) {
    const user = await env.DB
      .prepare(
        `SELECT u.id, u.username FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?1 AND s.expires_at > datetime('now')`,
      )
      .bind(await sha256Hex(token))
      .first<UserRow>();
    if (user) return user;
  }
  const authHeader = request.headers.get("Authorization") ?? "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (apiKey) {
    const user = await env.DB
      .prepare("SELECT id, username FROM users WHERE api_key = ?1")
      .bind(apiKey)
      .first<UserRow>();
    if (user) return user;
  }
  return null;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const origin = request.headers.get("Origin");

  if (origin && !isAllowedOrigin(origin, env)) {
    return fail(403, "不允许的请求来源", request, env);
  }

  // CORS 预检：浏览器不会在预检里带凭证，必须最先处理
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  sweepRateLimits(env, context as unknown as ExecutionContext);

  const segments = Array.isArray(params.route)
    ? params.route
    : params.route
      ? [params.route]
      : [];
  const [resource, sub, third] = segments;
  const url = new URL(request.url);
  const isWrite = request.method !== "GET" && request.method !== "HEAD";

  try {
    if (resource === "auth") {
      return await handleAuth(env, request, segments, url);
    }

    if (resource === "health" && request.method === "GET") {
      return json({ ok: true, data: { status: "up", time: new Date().toISOString() } }, request, env);
    }

    const user = await resolveUser(env, request);
    if (!user) {
      return fail(401, "未登录：请先登录，或在请求头携带 Authorization: Bearer <api_key>", request, env);
    }

    if (isWrite) {
      const gate = await enforceRateLimit(env, `write:${user.id}`, RATE_LIMITS.write);
      if (!gate.allowed) return rateLimited(gate.retryAfter, request, env);
    }

    if (resource === "progress" && !sub && request.method === "GET") {
      const platform = url.searchParams.get("platform") ?? "";
      if (!PLATFORMS.has(platform)) return fail(400, "platform 缺失或不支持", request, env);
      const { results } = await env.DB
        .prepare(
          `${PROGRESS_SELECT} WHERE p.user_id = ?1 AND p.platform = ?2
           ORDER BY p.last_attempt_at DESC, p.slug LIMIT ?3`,
        )
        .bind(user.id, platform, QUOTAS.progressRows)
        .all<ProgressRow>();
      return json({ ok: true, data: results.map(serializeProgress) }, request, env);
    }

    if (resource === "progress" && sub) {
      const rule = PLATFORMS.get(sub);
      if (!rule) return fail(400, "platform 不支持", request, env);
      if (!third || segments.length > 3 || !rule.slug.test(third)) {
        return fail(400, "slug 缺失或格式不合法", request, env);
      }
      const platform = sub;
      const slug = third;

      if (request.method === "GET") {
        const row = await env.DB
          .prepare(`${PROGRESS_SELECT} WHERE p.user_id = ?1 AND p.platform = ?2 AND p.slug = ?3`)
          .bind(user.id, platform, slug)
          .first<ProgressRow>();
        const { results: attemptRows } = await env.DB
          .prepare(
            `SELECT ${ATTEMPT_COLUMNS} FROM attempts
             WHERE user_id = ?1 AND platform = ?2 AND slug = ?3 ORDER BY id DESC LIMIT 20`,
          )
          .bind(user.id, platform, slug)
          .all();
        const attempts = serializeAttempts(attemptRows as Parameters<typeof serializeAttempts>[0]);
        return json({
          ok: true,
          data: { progress: row ? serializeProgress(row) : null, attempts },
        }, request, env);
      }

      if (request.method === "PUT") {
        const body = await readJsonObject(request);
        if (!body) return fail(400, "请求体必须是 JSON 对象", request, env);

        let done: number | null = null;
        if (body.done !== undefined) {
          if (typeof body.done !== "boolean") return fail(400, "done 必须是布尔值", request, env);
          done = body.done ? 1 : 0;
        }
        let mastery: number | null = null;
        if (body.mastery !== undefined) {
          if (typeof body.mastery !== "number" || !Number.isInteger(body.mastery) || body.mastery < 0 || body.mastery > 5) {
            return fail(400, "mastery 必须是 0-5 的整数", request, env);
          }
          mastery = body.mastery;
        }
        let urgency: number | null = null;
        if (body.urgency !== undefined) {
          if (typeof body.urgency !== "number" || !Number.isInteger(body.urgency) || body.urgency < 0 || body.urgency > 3) {
            return fail(400, "urgency 必须是 0-3 的整数", request, env);
          }
          urgency = body.urgency;
        }
        let tags: string[] | null = null;
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags) || body.tags.length > 10) {
            return fail(400, "tags 必须是最多包含 10 项的字符串数组", request, env);
          }
          const normalized: string[] = [];
          for (const value of body.tags) {
            if (typeof value !== "string") return fail(400, "tags 每一项都必须是字符串", request, env);
            const tag = value.trim();
            if (!tag || tag.length > 20) return fail(400, "每个标签长度必须为 1-20 个字符", request, env);
            if (!normalized.includes(tag)) normalized.push(tag);
          }
          tags = normalized;
        }
        let note: string | null | undefined;
        if (body.note !== undefined) {
          if (typeof body.note !== "string") {
            return fail(400, "note 必须是字符串（传空字符串表示清除笔记）", request, env);
          }
          if (body.note.length > MAX_NOTE_LENGTH) {
            return fail(400, `note 过长（上限 ${MAX_NOTE_LENGTH} 字符）`, request, env);
          }
          note = body.note === "" ? null : body.note;
        }
        if (done === null && mastery === null && urgency === null && tags === null && note === undefined) {
          return fail(400, "至少提供 done / mastery / urgency / tags / note 之一", request, env);
        }

        const existing = await env.DB
          .prepare("SELECT 1 AS hit FROM progress WHERE user_id = ?1 AND platform = ?2 AND slug = ?3")
          .bind(user.id, platform, slug)
          .first<{ hit: number }>();
        if (!existing && (await isOverQuota(env, "progress", user.id, QUOTAS.progressRows))) {
          return fail(
            409,
            `题目进度数量已达上限（${QUOTAS.progressRows} 题）`,
            request,
            env,
          );
        }

        const bindValues: (number | string | null)[] = [];
        const addParam = (value: number | string | null): number => {
          bindValues.push(value);
          return bindValues.length + 3;
        };
        const doneIdx = done !== null ? addParam(done) : null;
        const masteryIdx = mastery !== null ? addParam(mastery) : null;
        const urgencyIdx = urgency !== null ? addParam(urgency) : null;
        const tagsIdx = tags !== null ? addParam(JSON.stringify(tags)) : null;
        const noteIdx = note !== undefined ? addParam(note) : null;

        const insertCols = ["user_id", "platform", "slug"];
        const insertVals = ["?1", "?2", "?3"];
        const updateSets: string[] = [];
        if (doneIdx !== null) {
          insertCols.push("done");
          insertVals.push(`?${doneIdx}`);
          updateSets.push(`done = ?${doneIdx}`);
        }
        if (masteryIdx !== null) {
          insertCols.push("mastery");
          insertVals.push(`?${masteryIdx}`);
          updateSets.push(`mastery = ?${masteryIdx}`);
        }
        if (urgencyIdx !== null) {
          insertCols.push("urgency");
          insertVals.push(`?${urgencyIdx}`);
          updateSets.push(`urgency = ?${urgencyIdx}`);
        }
        if (tagsIdx !== null) {
          insertCols.push("tags");
          insertVals.push(`?${tagsIdx}`);
          updateSets.push(`tags = ?${tagsIdx}`);
        }
        if (noteIdx !== null) {
          insertCols.push("note");
          insertVals.push(`?${noteIdx}`);
          updateSets.push(`note = ?${noteIdx}`);
        }

        await env.DB
          .prepare(
            `INSERT INTO progress (${insertCols.join(", ")}) VALUES (${insertVals.join(", ")})
             ON CONFLICT(user_id, platform, slug) DO UPDATE SET ${updateSets.join(", ")}`,
          )
          .bind(user.id, platform, slug, ...bindValues)
          .run();

        const row = await env.DB
          .prepare(`${PROGRESS_SELECT} WHERE p.user_id = ?1 AND p.platform = ?2 AND p.slug = ?3`)
          .bind(user.id, platform, slug)
          .first<ProgressRow>();
        return json({ ok: true, data: { progress: row ? serializeProgress(row) : null } }, request, env);
      }

      if (request.method === "DELETE") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM attempts WHERE user_id = ?1 AND platform = ?2 AND slug = ?3").bind(user.id, platform, slug),
          env.DB.prepare("DELETE FROM progress WHERE user_id = ?1 AND platform = ?2 AND slug = ?3").bind(user.id, platform, slug),
        ]);
        return json({ ok: true, data: { platform, slug, deleted: true } }, request, env);
      }
    }

    if (resource === "attempts" && !sub) {
      if (request.method === "POST") {
        const body = await readJsonObject(request);
        if (!body) return fail(400, "请求体必须是 JSON 对象", request, env);

        const site = typeof body.site === "string" ? body.site : "";
        const platform = SITE_PLATFORM.get(site);
        if (!platform) return fail(400, "site 缺失或不支持", request, env);
        const slug = body.slug;
        if (typeof slug !== "string" || !PLATFORMS.get(platform)!.slug.test(slug)) {
          return fail(400, "slug 缺失或不合法", request, env);
        }
        const result = body.result;
        if (result !== "pass" && result !== "fail") {
          return fail(400, "result 必须是 'pass' 或 'fail'", request, env);
        }
        const timeMs = body.timeMs;
        if (
          typeof timeMs !== "number" ||
          !Number.isFinite(timeMs) ||
          timeMs < 0 ||
          timeMs > MAX_TIME_MS
        ) {
          return fail(400, `timeMs 必须是 0 ~ ${MAX_TIME_MS}（24h）之间的毫秒数`, request, env);
        }
        const language = optionalText(body.language, 64);
        if (language === false) return fail(400, "language 必须是字符串（≤64 字符）", request, env);
        const verdict = optionalText(body.verdict, 40);
        if (verdict === false) return fail(400, "verdict 必须是字符串（≤40 字符）", request, env);
        const title = optionalText(body.title, 200);
        if (title === false) return fail(400, "title 必须是字符串（≤200 字符）", request, env);
        const difficulty = optionalText(body.difficulty, 32);
        if (difficulty === false) return fail(400, "difficulty 必须是字符串（≤32 字符）", request, env);
        const note = parseNote(body.note);
        if (note === false) return fail(400, `note 必须是字符串（≤${MAX_NOTE_LENGTH} 字符）`, request, env);
        const submissionId = body.submissionId === undefined ? null : body.submissionId;
        if (
          submissionId !== null &&
          (typeof submissionId !== "string" || !/^\d{1,20}$/.test(submissionId))
        ) {
          return fail(400, "submissionId 必须是数字字符串（平台提交 id）", request, env);
        }

        if (await isOverQuota(env, "attempts", user.id, QUOTAS.attemptRows)) {
          return fail(409, `作答记录数量已达上限（${QUOTAS.attemptRows} 条）`, request, env);
        }

        const time = Math.round(timeMs);
        const inserted = await env.DB
          .prepare(
            `INSERT INTO attempts (user_id, platform, slug, site, result, verdict, time_ms, language, submission_id, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(user_id, site, submission_id) WHERE submission_id IS NOT NULL DO NOTHING
             RETURNING ${ATTEMPT_COLUMNS}`,
          )
          .bind(user.id, platform, slug, site, result, verdict, time, language, submissionId, note)
          .first<AttemptRow>();

        const attempt = inserted ?? (submissionId
          ? await env.DB
              .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE user_id = ?1 AND site = ?2 AND submission_id = ?3`)
              .bind(user.id, site, submissionId)
              .first<AttemptRow>()
          : null);
        if (!attempt) throw new Error("作答记录写入失败");

        // 每次都根据作答流水重新计算汇总。重复 submissionId 只修复汇总，不增加次数或耗时。
        await env.DB
          .prepare(
            `INSERT INTO progress (
               user_id, platform, slug, title, difficulty, done, mastery,
               first_attempt_at, last_attempt_at, total_time_ms, attempt_count, last_result
             )
             SELECT ?1, ?2, ?3, ?4, ?5,
                    EXISTS(SELECT 1 FROM attempts WHERE user_id = ?1 AND platform = ?2 AND slug = ?3 AND result = 'pass'),
                    0, MIN(created_at), MAX(created_at), COALESCE(SUM(time_ms), 0), COUNT(*),
                    ${LATEST_RESULT_SUBQUERY}
             FROM attempts WHERE user_id = ?1 AND platform = ?2 AND slug = ?3
             ON CONFLICT(user_id, platform, slug) DO UPDATE SET
               title = COALESCE(excluded.title, progress.title),
               difficulty = COALESCE(excluded.difficulty, progress.difficulty),
               done = excluded.done,
               first_attempt_at = excluded.first_attempt_at,
               last_attempt_at = excluded.last_attempt_at,
               total_time_ms = excluded.total_time_ms,
               attempt_count = excluded.attempt_count,
               last_result = excluded.last_result`,
          )
          .bind(user.id, attempt.platform, attempt.slug, title, difficulty)
          .run();

        const row = await env.DB
          .prepare(`${PROGRESS_SELECT} WHERE p.user_id = ?1 AND p.platform = ?2 AND p.slug = ?3`)
          .bind(user.id, attempt.platform, attempt.slug)
          .first<ProgressRow>();
        return json({
          ok: true,
          data: {
            progress: row ? serializeProgress(row) : null,
            attempt: serializeAttempts([attempt])[0],
            duplicate: inserted === null,
          },
        }, request, env, inserted ? 201 : 200);
      }

      if (request.method === "GET") {
        const limitRaw = Number(url.searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(limitRaw)
          ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
          : 50;
        const { results: attemptRows } = await env.DB
          .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2`)
          .bind(user.id, limit)
          .all();
        return json({ ok: true, data: serializeAttempts(attemptRows as Parameters<typeof serializeAttempts>[0]) }, request, env);
      }
    }

    if (resource === "attempts" && sub && (request.method === "PUT" || request.method === "DELETE")) {
      const attemptId = Number(sub);
      if (!Number.isInteger(attemptId) || attemptId <= 0) {
        return fail(400, "作答 id 不合法", request, env);
      }

      if (request.method === "PUT") {
        const body = await readJsonObject(request);
        if (!body || typeof body.note !== "string") {
          return fail(400, "请求体需为 {note: string}", request, env);
        }
        const note = parseNote(body.note);
        if (note === false) return fail(400, `note 过长（上限 ${MAX_NOTE_LENGTH} 字符）`, request, env);

        const { results: attemptRows } = await env.DB
          .prepare(`UPDATE attempts SET note = ?3 WHERE id = ?1 AND user_id = ?2 RETURNING ${ATTEMPT_COLUMNS}`)
          .bind(attemptId, user.id, note)
          .all();
        if (attemptRows.length === 0) return fail(404, "作答记录不存在", request, env);
        return json({ ok: true, data: { attempt: serializeAttempts(attemptRows as Parameters<typeof serializeAttempts>[0])[0] } }, request, env);
      }

      const deleted = await env.DB
        .prepare("DELETE FROM attempts WHERE id = ?1 AND user_id = ?2 RETURNING platform, slug")
        .bind(attemptId, user.id)
        .first<{ platform: string; slug: string }>();
      if (!deleted) return fail(404, "作答记录不存在", request, env);

      const sameProblem = "user_id = ?1 AND platform = ?2 AND slug = ?3";
      await env.DB
        .prepare(
          `UPDATE progress SET
             done = EXISTS(SELECT 1 FROM attempts WHERE ${sameProblem} AND result = 'pass'),
             attempt_count = (SELECT COUNT(*) FROM attempts WHERE ${sameProblem}),
             total_time_ms = (SELECT COALESCE(SUM(time_ms), 0) FROM attempts WHERE ${sameProblem}),
             first_attempt_at = (SELECT MIN(created_at) FROM attempts WHERE ${sameProblem}),
             last_attempt_at = (SELECT MAX(created_at) FROM attempts WHERE ${sameProblem}),
             last_result = ${LATEST_RESULT_SUBQUERY}
           WHERE ${sameProblem}`,
        )
        .bind(user.id, deleted.platform, deleted.slug)
        .run();

      const row = await env.DB
        .prepare(`${PROGRESS_SELECT} WHERE p.user_id = ?1 AND p.platform = ?2 AND p.slug = ?3`)
        .bind(user.id, deleted.platform, deleted.slug)
        .first<ProgressRow>();
      return json(
        {
          ok: true,
          data: { platform: deleted.platform, slug: deleted.slug, deleted: true, progress: row ? serializeProgress(row) : null },
        },
        request,
        env,
      );
    }

    return fail(404, `未知接口：${request.method} /api/${segments.join("/")}`, request, env);
  } catch (error) {
    // 异常原文不回给客户端，只进服务端日志
    console.error("[api] unhandled error", request.method, url.pathname, error);
    return fail(500, "服务器内部错误", request, env);
  }
};

async function handleAuth(
  env: Env,
  request: Request,
  segments: string[],
  url: URL,
): Promise<Response> {
  const action = segments[1];
  const ip = clientIp(request);
  // 人机验证放在最前面：没通过的请求不占限流计数，也不写数据库
  const passesTurnstile = (body: Record<string, unknown> | null, expectedAction: string) =>
    verifyTurnstile({
      secret: env.TURNSTILE_SECRET,
      token: body?.turnstileToken,
      action: expectedAction,
      hostnames: turnstileHostnames(env),
      remoteip: request.headers.get("CF-Connecting-IP") ?? undefined,
    });
  const turnstileFailed = () => fail(403, "人机验证未通过，请刷新页面后重试", request, env);

  if (action === "register" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (!(await passesTurnstile(body, "signup"))) return turnstileFailed();

    const gate = await enforceRateLimit(env, `register:${ip}`, RATE_LIMITS.register);
    if (!gate.allowed) return rateLimited(gate.retryAfter, request, env);

    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!USERNAME_RE.test(username)) {
      return fail(400, "用户名需为 3-24 位字母/数字/下划线/短横线", request, env);
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return fail(400, `密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`, request, env);
    }
    const exists = await env.DB
      .prepare("SELECT id FROM users WHERE username = ?1")
      .bind(username)
      .first();
    if (exists) return fail(409, "用户名已被注册", request, env);

    const { results } = await env.DB
      .prepare(
        "INSERT INTO users (username, password_hash, api_key) VALUES (?1, ?2, ?3) RETURNING id, username",
      )
      .bind(username, await hashPassword(password), generateApiKey())
      .all<UserRow>();
    const user = results[0];
    const cookie = await createSession(env, user.id);
    const res = json({ ok: true, data: { user } }, request, env, 201);
    res.headers.append("Set-Cookie", cookie);
    return res;
  }

  if (action === "login" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (!(await passesTurnstile(body, "login"))) return turnstileFailed();

    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    const byIp = await enforceRateLimit(env, `login:ip:${ip}`, RATE_LIMITS.loginByIp);
    if (!byIp.allowed) return rateLimited(byIp.retryAfter, request, env);
    if (username) {
      const byUser = await enforceRateLimit(
        env,
        `login:user:${username.toLowerCase()}`,
        RATE_LIMITS.loginByUser,
      );
      if (!byUser.allowed) return rateLimited(byUser.retryAfter, request, env);
    }

    const row = await env.DB
      .prepare("SELECT id, username, password_hash FROM users WHERE username = ?1")
      .bind(username)
      .first<{ id: number; username: string; password_hash: string }>();
    if (!row) {
      // 用户名不存在时也付出等量 PBKDF2 代价，抹掉响应时间差这个枚举 oracle
      await burnPasswordTime(password);
      return fail(401, "用户名或密码错误", request, env);
    }
    if (!(await verifyPassword(password, row.password_hash))) {
      return fail(401, "用户名或密码错误", request, env);
    }
    const cookie = await createSession(env, row.id);
    const res = json({ ok: true, data: { user: { id: row.id, username: row.username } } }, request, env);
    res.headers.append("Set-Cookie", cookie);
    return res;
  }

  if (action === "logout" && request.method === "POST") {
    const token = readSessionToken(request);
    if (token) {
      await env.DB
        .prepare("DELETE FROM sessions WHERE token_hash = ?1")
        .bind(await sha256Hex(token))
        .run();
    }
    const res = json({ ok: true, data: { loggedOut: true } }, request, env);
    res.headers.append("Set-Cookie", sessionCookie("", 0));
    return res;
  }

  if (action === "me" && request.method === "GET") {
    const user = await resolveUser(env, request);
    if (!user) return fail(401, "未登录", request, env);
    return json({ ok: true, data: { user } }, request, env);
  }

  // 仅允许当前网页登录会话修改密码
  if (action === "password" && request.method === "POST") {
    const token = readSessionToken(request);
    if (!token) return fail(401, "请先登录后再修改密码", request, env);
    const user = await env.DB
      .prepare(
        `SELECT u.id, u.username, u.password_hash FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?1 AND s.expires_at > datetime('now')`,
      )
      .bind(await sha256Hex(token))
      .first<{ id: number; username: string; password_hash: string }>();
    if (!user) return fail(401, "登录已过期，请重新登录", request, env);

    const gate = await enforceRateLimit(env, `password:${user.id}`, RATE_LIMITS.password);
    if (!gate.allowed) return rateLimited(gate.retryAfter, request, env);

    const body = await readJsonObject(request);
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
      return fail(400, `新密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`, request, env);
    }
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      return fail(401, "当前密码错误", request, env);
    }

    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ?2 WHERE id = ?1").bind(user.id, await hashPassword(newPassword)),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
    ]);
    const cookie = await createSession(env, user.id);
    const res = json({ ok: true, data: { changed: true } }, request, env);
    res.headers.append("Set-Cookie", cookie);
    return res;
  }

  void url;
  return fail(404, `未知接口：POST /api/auth/${action ?? ""}`, request, env);
}
