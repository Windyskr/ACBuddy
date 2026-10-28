// 用法：[ACB_DEV_PASSWORD=<自定义密码>] node scripts/db-seed.mjs [local|remote]
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const mode = process.argv[2] === "remote" ? "remote" : "local";
const flag = mode === "remote" ? "--remote" : "--local";

const ITERATIONS = 100_000;
function toBase64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, key, 256);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) throw new Error(`wrangler 输出中没有 JSON：${text.slice(0, 200)}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`wrangler 输出的 JSON 不完整：${text.slice(0, 200)}`);
}

function d1(sql) {
  const out = execSync(
    `npx wrangler d1 execute acbuddy-db ${flag} --command "${sql.replace(/"/g, '\\"')}" --json`,
    { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return extractJson(out);
}

const DEV_USERNAME = process.env.ACB_DEV_USERNAME ?? "dev";
const DEV_PASSWORD = process.env.ACB_DEV_PASSWORD ?? `dev-${randomBytes(9).toString("base64url")}`;
const generatedPassword = !process.env.ACB_DEV_PASSWORD;
const apiKey = `acb_${randomBytes(16).toString("hex")}`;

if (mode === "remote") {
  console.warn(
    "⚠️  正在对**线上**数据库创建开发账号。线上不需要这个账号的话请直接 Ctrl-C。\n",
  );
}
const passwordHash = await hashPassword(DEV_PASSWORD);

const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;
d1(`INSERT OR IGNORE INTO users (username, password_hash, api_key) VALUES (${lit(DEV_USERNAME)}, ${lit(passwordHash)}, ${lit(apiKey)})`);
const res = d1(`SELECT username, api_key FROM users WHERE username = ${lit(DEV_USERNAME)}`);
const row = res.results?.[0];

const created = row?.api_key === apiKey;
console.log(`\nD1(${mode}) 开发账号：${row?.username}`);
if (created) {
  console.log(`D1(${mode}) 密码：${DEV_PASSWORD}${generatedPassword ? "（随机生成，只显示这一次，请自行保存）" : ""}`);
} else {
  console.log(`D1(${mode}) 密码：（用户已存在，沿用原密码，本次未修改）`);
}
console.log(`D1(${mode}) 开发 api_key：${row?.api_key}（Bearer 调试用）`);
