import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { McpClient, ARTIFACTS, PROFILE_DIR } from './mcp-client.mjs';

// 检查测试 Profile 有没有登录 ACBuddy。登录、注册都要过 Turnstile 人机验证，自动化浏览器过不了，
// 所以脚本只检查、不登录，没登录时按提示手动登录。
// 测试账号凭据：ACB_TEST_USERNAME / ACB_TEST_PASSWORD，或 .mcp-artifacts/site-account.json；都没有就生成一组，供手动注册
const SITE = process.env.ACB_SITE ?? 'https://acbuddy.pages.dev';
const ACCOUNT_FILE = path.join(ARTIFACTS, 'site-account.json');

function loadCredentials() {
  if (process.env.ACB_TEST_USERNAME && process.env.ACB_TEST_PASSWORD) {
    return { username: process.env.ACB_TEST_USERNAME, password: process.env.ACB_TEST_PASSWORD };
  }
  try {
    const saved = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8'));
    if (saved?.username && saved?.password) return { username: saved.username, password: saved.password };
  } catch {
  }
  const rand = (n) => randomBytes(n).toString('hex');
  return { username: `e2e-${rand(4)}`, password: `E2e-${rand(12)}!` };
}
const { username: USERNAME, password: PASSWORD } = loadCredentials();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(ARTIFACTS, { recursive: true });

const unwrap = (s) => {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const b = m ? m[1].trim() : s.trim();
  try {
    return JSON.parse(b);
  } catch {
    return b;
  }
};

const mcp = new McpClient();
let ok = false;
try {
  await mcp.start();
  const np = mcp.text(await mcp.call('new_page', { url: SITE, timeout: 60000 }, 90000));
  const pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  if (!Number.isFinite(pageId)) throw new Error(`cannot resolve pageId:\n${np}`);
  await sleep(1500);

  const meRes = unwrap(
    mcp.text(
      await mcp.call(
        'evaluate_script',
        {
          pageId,
          function: `async () => { const r = await fetch('/api/auth/me', { credentials: 'include' }); return { status: r.status, body: await r.json() }; }`,
        },
        60000,
      ),
    ),
  );
  console.log('auth/me:', JSON.stringify(meRes));
  writeFileSync(
    ACCOUNT_FILE,
    JSON.stringify({ site: SITE, username: USERNAME, password: PASSWORD, lastMe: meRes }, null, 2),
  );
  ok = meRes?.status === 200 && meRes?.body?.ok === true;
  const loggedInAs = meRes?.body?.data?.user?.username;
  if (ok && loggedInAs !== USERNAME) {
    console.log(`注意：Profile 登录的是 ${loggedInAs}，不是 site-account.json 里的 ${USERNAME}`);
  }
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}
if (!ok) {
  console.log(
    [
      '\n测试 Profile 没有登录 ACBuddy。登录要过人机验证，请手动登录：',
      `用普通（不受自动化控制的）Chrome 加 --user-data-dir=${PROFILE_DIR} 打开 ${SITE}，`,
      `用 ${ACCOUNT_FILE} 里的用户名和密码登录（账号不存在就先注册），关掉窗口后重跑本脚本。`,
    ].join('\n'),
  );
}
console.log(`\n== LOGIN STATE: ${ok ? 'OK (session cookie stored in .chrome-profile)' : 'NOT LOGGED IN'} ==`);
process.exitCode = ok ? 0 : 1;
