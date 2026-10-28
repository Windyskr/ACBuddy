// 用法：node scripts/db-migrate.mjs local|remote [--status | --baseline [迁移文件名] | --reset]
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(ROOT, "migrations");
const DB_NAME = "acbuddy-db";

const args = process.argv.slice(2);
const mode = args.includes("remote") ? "remote" : "local";
const flag = mode === "remote" ? "--remote" : "--local";
const statusOnly = args.includes("--status");
const baseline = args.includes("--baseline");
const baselineThrough = baseline ? args[args.indexOf("--baseline") + 1] : undefined;
const reset = args.includes("--reset");
const force = args.includes("--force");

if (reset && mode === "remote" && !force) {
  console.error(
    "拒绝执行：--reset 会清空线上数据库的全部数据。\n" +
      "确实要这么做请显式加 --force：node scripts/db-migrate.mjs remote --reset --force",
  );
  process.exit(1);
}

function wrangler(extraArgs, { json = false } = {}) {
  const argv = ["wrangler", "d1", "execute", DB_NAME, flag, ...extraArgs, "-y"];
  if (json) argv.push("--json");
  const out = execFileSync("npx", argv, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!json) return out;
  // wrangler 会在 JSON 前面打印几行提示，从第一个 JSON 值开始解析
  const start = out.search(/[[{]/);
  if (start === -1) throw new Error(`wrangler 输出里没有 JSON：${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start));
}

const sql = (command, opts) => wrangler(["--command", command], opts);
const file = (path) => wrangler(["--file", path]);

function rowsOf(result) {
  const first = Array.isArray(result) ? result[0] : result;
  return first?.results ?? [];
}

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

if (migrations.length === 0) {
  console.error(`migrations/ 下没有 .sql 文件`);
  process.exit(1);
}

if (reset) {
  console.log(`[${mode}] --reset：删除全部表…`);
  // sqlite_* 和 D1 的 _cf_* 是内部表，不能删
  const tables = rowsOf(
    sql(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      { json: true },
    ),
  ).map((row) => row.name);
  if (tables.length > 0) {
    sql(`PRAGMA defer_foreign_keys=ON; ${tables.map((t) => `DROP TABLE IF EXISTS "${t}";`).join(" ")}`);
    console.log(`  已删除 ${tables.length} 张表：${tables.join(", ")}`);
  } else {
    console.log("  （库本来就是空的）");
  }
}

sql(
  "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
);

const applied = new Set(
  rowsOf(sql("SELECT name FROM schema_migrations", { json: true })).map((row) => row.name),
);
const pending = migrations.filter((name) => !applied.has(name));

if (statusOnly) {
  console.log(`\n[${mode}] 迁移状态：`);
  for (const name of migrations) {
    console.log(`  ${applied.has(name) ? "✓ 已执行" : "· 待执行"}  ${name}`);
  }
  console.log(`\n共 ${migrations.length} 个，待执行 ${pending.length} 个。`);
  process.exit(0);
}

if (baseline) {
  let target = pending;
  if (baselineThrough && !baselineThrough.startsWith("--")) {
    const cut = migrations.indexOf(baselineThrough);
    if (cut === -1) {
      console.error(
        `--baseline 指定的迁移不存在：${baselineThrough}\n可选：\n  ${migrations.join("\n  ")}`,
      );
      process.exit(1);
    }
    const through = new Set(migrations.slice(0, cut + 1));
    target = pending.filter((name) => through.has(name));
  }
  if (target.length === 0) {
    console.log(`[${mode}] 没有需要标记的迁移。`);
    process.exit(0);
  }
  const values = target.map((name) => `('${name.replace(/'/g, "''")}')`).join(", ");
  sql(`INSERT OR IGNORE INTO schema_migrations (name) VALUES ${values}`);
  console.log(
    `[${mode}] 已把 ${target.length} 个迁移标记为「已执行」（未实际执行 SQL）：\n  ${target.join("\n  ")}`,
  );
  const rest = pending.filter((name) => !target.includes(name));
  if (rest.length > 0) {
    console.log(`\n仍待执行 ${rest.length} 个，重新跑一次不带 --baseline 的命令即可执行它们：\n  ${rest.join("\n  ")}`);
  }
  process.exit(0);
}

if (pending.length === 0) {
  console.log(`[${mode}] schema 已是最新，没有待执行的迁移。`);
  process.exit(0);
}

console.log(`[${mode}] 待执行 ${pending.length} 个迁移：`);
for (const name of pending) {
  process.stdout.write(`  → ${name} … `);
  try {
    file(join(MIGRATIONS_DIR, name));
  } catch (error) {
    console.log("失败");
    console.error(`\n迁移 ${name} 执行失败，已停在这一步（之前的迁移已记账）。\n`, error.message ?? error);
    process.exit(1);
  }
  sql(`INSERT OR IGNORE INTO schema_migrations (name) VALUES ('${name.replace(/'/g, "''")}')`);
  console.log("完成");
}
console.log(`\n[${mode}] 全部迁移执行完毕。`);
