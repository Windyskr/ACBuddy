import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { McpClient, ARTIFACTS } from './mcp-client.mjs';

// 加 --check-only 只查 /api/auth/me（持久化检查）；覆盖凭据：ACB_TEST_USERNAME=xxx ACB_TEST_PASSWORD=yyy
const SITE = process.env.ACB_SITE ?? 'https://acbuddy.pages.dev';

function loadCredentials() {
  if (process.env.ACB_TEST_USERNAME && process.env.ACB_TEST_PASSWORD) {
    return { username: process.env.ACB_TEST_USERNAME, password: process.env.ACB_TEST_PASSWORD };
  }
  try {
    const saved = JSON.parse(readFileSync(path.join(ARTIFACTS, 'site-account.json'), 'utf8'));
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

  const evalInPage = async (fn) =>
    unwrap(mcp.text(await mcp.call('evaluate_script', { pageId, function: fn }, 60000)));

  const me = () =>
    evalInPage(
      `async () => { const r = await fetch('/api/auth/me', { credentials: 'include' }); return { status: r.status, body: await r.json() }; }`,
    );

  if (!process.argv.includes('--check-only')) {
    const reg = await evalInPage(
      `async () => {
        const r = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: ${JSON.stringify(USERNAME)}, password: ${JSON.stringify(PASSWORD)} }),
        });
        return { status: r.status, body: await r.json() };
      }`,
    );
    console.log('register:', JSON.stringify(reg));
    writeFileSync(path.join(ARTIFACTS, 'site-register.json'), JSON.stringify(reg, null, 2));

    if (reg.status !== 200 && reg.status !== 201) {
      const login = await evalInPage(
        `async () => {
          const r = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username: ${JSON.stringify(USERNAME)}, password: ${JSON.stringify(PASSWORD)} }),
          });
          return { status: r.status, body: await r.json() };
        }`,
      );
      console.log('login fallback:', JSON.stringify(login));
      writeFileSync(path.join(ARTIFACTS, 'site-login.json'), JSON.stringify(login, null, 2));
    }
  }

  const meRes = await me();
  console.log('auth/me:', JSON.stringify(meRes));
  writeFileSync(
    path.join(ARTIFACTS, 'site-account.json'),
    JSON.stringify(
      { site: SITE, username: USERNAME, password: PASSWORD, lastMe: meRes },
      null,
      2,
    ),
  );
  ok = meRes?.status === 200 && meRes?.body?.ok === true;
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}
console.log(`\n== LOGIN STATE: ${ok ? 'OK (session cookie stored in .chrome-profile)' : 'FAILED'} ==`);
process.exitCode = ok ? 0 : 1;
