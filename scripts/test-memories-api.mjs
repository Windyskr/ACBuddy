// 长期记忆同步接口的集成测试，只用本地 D1 和本地服务。
// 先起服务：npm run build && wrangler pages dev dist --port 8788，再运行：node scripts/test-memories-api.mjs
// 会建两个临时账号，结束时连同它们的数据一起删掉。
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.ACB_API_BASE ?? "http://127.0.0.1:8788";
const A = { key: "memtest-key-a", name: "memtest-a" };
const B = { key: "memtest-key-b", name: "memtest-b" };

function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "acbuddy-db", "--local", "--json", "-y", "--command", command], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.search(/[[{]/)))[0].results;
}

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
async function api(user, method, path, body, headers = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${user.key}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: res.status === 204 ? null : await res.json().catch(() => null) };
}
const memory = (id, extra = {}) => ({
  id, type: "semantic", text: `记忆 ${id}`, concepts: ["动态规划"], problemKey: null, importance: 3, attemptIds: [], sources: [],
  validFrom: 1000, invalidAt: null, createdAt: 1000, supersededBy: null, ...extra,
});
const put = (user, ...records) => api(user, "POST", "/memories/sync", { put: records });
async function pullAll(user) {
  const all = [];
  let since = 0;
  let after = "";
  let pages = 0;
  for (;;) {
    const res = await api(user, "GET", `/memories?since=${since}&after=${encodeURIComponent(after)}`);
    if (res.status !== 200) throw new Error(`pull ${res.status}`);
    pages++;
    all.push(...res.json.data.memories);
    if (!res.json.data.more) return { all, pages };
    const last = res.json.data.memories.at(-1);
    since = last.updatedAt;
    after = last.id;
  }
}

function cleanup() {
  const ids = `(SELECT id FROM users WHERE username IN ('${A.name}', '${B.name}'))`;
  sql(`DELETE FROM memories WHERE user_id IN ${ids}; DELETE FROM rate_limits WHERE bucket LIKE 'memory-%' OR bucket LIKE 'write:%'; DELETE FROM users WHERE username IN ('${A.name}', '${B.name}');`);
}

cleanup();
sql(`INSERT INTO users (username, password_hash, api_key) VALUES ('${A.name}', 'x', '${A.key}'), ('${B.name}', 'x', '${B.key}');`);
try {
  // 认证和来源
  check("requires_login", (await api(null, "GET", "/memories")).status === 401);
  check("rejects_unknown_origin", (await api(A, "GET", "/memories", undefined, { Origin: "https://evil.example" })).status === 403);
  const preflight = await api(null, "OPTIONS", "/memories/sync", undefined, { Origin: "chrome-extension://eeelmpabikchngepjjphbibccnlilnek" });
  check("allows_extension_preflight", preflight.status === 204 && (preflight.headers.get("access-control-allow-methods") ?? "").includes("DELETE"));

  // 校验
  check("rejects_too_many", (await api(A, "POST", "/memories/sync", { put: Array.from({ length: 21 }, (_, i) => memory(`m${i}`)) })).status === 400);
  check("rejects_bad_type", (await put(A, memory("x", { type: "skill" }))).status === 400);
  check("rejects_long_text", (await put(A, memory("x", { text: "字".repeat(1001) }))).status === 400);
  check("rejects_reserved_id", (await put(A, memory("__cleared__"))).status === 400);
  check("rejects_bad_body", (await api(A, "POST", "/memories/sync", { put: "nope" })).status === 400);
  check("rejects_bad_since", (await api(A, "GET", "/memories?since=abc")).status === 400);
  check("nothing_to_do_is_ok", (await api(A, "POST", "/memories/sync", {})).status === 200);

  // 写入和读取
  check("saves_memory", (await put(A, memory("a1", { quote: "用户的原话", evidence: [{ quote: "用户的原话" }], attemptIds: [7] }))).status === 200);
  let { all } = await pullAll(A);
  check("reads_memory_back", all.length === 1 && all[0].text === "记忆 a1" && all[0].concepts[0] === "动态规划" && all[0].attemptIds[0] === 7 && all[0].deleted === false);
  check("does_not_store_extra_fields", !JSON.stringify(sql(`SELECT * FROM memories WHERE id = 'a1'`)).includes("用户的原话") && !JSON.stringify(all).includes("用户的原话"));
  const firstWrite = all[0].updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await put(A, memory("a1", { text: "改过的", invalidAt: 2000, supersededBy: "a2" }));
  ({ all } = await pullAll(A));
  check("later_write_wins", all.length === 1 && all[0].text === "改过的" && all[0].invalidAt === 2000 && all[0].supersededBy === "a2" && all[0].updatedAt > firstWrite);
  const incremental = await api(A, "GET", `/memories?since=${all[0].updatedAt}&after=${all[0].id}`);
  check("cursor_skips_seen_rows", incremental.json.data.memories.length === 0);

  // 账号之间隔离
  check("other_account_sees_nothing", (await pullAll(B)).all.length === 0);
  await api(B, "POST", "/memories/sync", { remove: ["a1"] });
  ({ all } = await pullAll(A));
  check("other_account_cannot_delete", all[0].text === "改过的" && all[0].deleted === false);

  // 删除：内容马上清空，不能写回来
  await api(A, "POST", "/memories/sync", { remove: ["a1"] });
  ({ all } = await pullAll(A));
  check("delete_wipes_content", all[0].deleted === true && all[0].text === "" && all[0].concepts.length === 0);
  await put(A, memory("a1", { text: "离线设备上的旧改动" }));
  ({ all } = await pullAll(A));
  check("delete_wins_over_stale_write", all[0].deleted === true && all[0].text === "");

  // 翻页：同一批写入的 updatedAt 相同，靠 id 分开，不能漏也不能重复
  for (let batch = 0; batch < 11; batch++) await put(A, ...Array.from({ length: 20 }, (_, i) => memory(`p${String(batch).padStart(2, "0")}-${i}`)));
  const paged = await pullAll(A);
  check("pagination_is_complete", paged.pages === 2 && paged.all.length === 221 && new Set(paged.all.map((item) => item.id)).size === 221, `${paged.pages} 页 ${paged.all.length} 条`);

  // 清空：真的删掉，留一条标记
  const cleared = await api(A, "DELETE", "/memories");
  ({ all } = await pullAll(A));
  check("clear_removes_everything", cleared.status === 200 && all.length === 1 && all[0].id === "__cleared__" && all[0].deleted === true, `${all.length} 条`);
  check("clear_only_my_data", sql(`SELECT COUNT(*) AS n FROM memories m JOIN users u ON m.user_id = u.id WHERE u.username = '${B.name}'`)[0].n === 1);
  await put(A, memory("after-clear"));
  ({ all } = await pullAll(A));
  check("can_write_after_clear", all.some((item) => item.id === "after-clear" && item.deleted === false));

  // 上限
  sql(`INSERT INTO rate_limits (bucket, hits, window_start) SELECT 'memory-sync:' || id, 100, unixepoch() FROM users WHERE username = '${A.name}' ON CONFLICT(bucket) DO UPDATE SET hits = 100, window_start = excluded.window_start;`);
  const limited = await put(A, memory("limited"));
  check("daily_sync_limit", limited.status === 429 && Number(limited.headers.get("retry-after")) > 0);
  sql(`DELETE FROM rate_limits WHERE bucket LIKE 'memory-sync:%';`);
  sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001) INSERT INTO memories (user_id, id, type, text, valid_from, created_at, updated_at) SELECT (SELECT id FROM users WHERE username = '${B.name}'), 'bulk-' || i, 'episodic', 'x', 0, 0, 1 FROM n;`);
  check("row_quota", (await put(B, memory("too-many"))).status === 413);
  check("clear_frees_the_quota", (await api(B, "DELETE", "/memories")).status === 200 && (await put(B, memory("room-again"))).status === 200);
} finally {
  cleanup();
}
const failed = results.filter((pass) => !pass).length;
console.log(`\n== MEMORIES API: ${failed ? `${failed} FAILED` : "ALL PASS"} ==`);
process.exitCode = failed ? 1 : 0;
