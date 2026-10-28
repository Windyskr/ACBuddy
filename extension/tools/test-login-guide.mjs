import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

const EXT_NAME = 'ACBuddy';
const SITE = 'https://acbuddy.pages.dev';
const PROBLEM_URL = 'https://leetcode.cn/problems/two-sum/';
const account = JSON.parse(readFileSync(path.join(ARTIFACTS, 'site-account.json'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return pass;
};
const unwrap = (s) => {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const b = m ? m[1].trim() : s.trim();
  try {
    return JSON.parse(b);
  } catch {
    return b;
  }
};
const pageLines = (text) =>
  (text.match(/^\s*(\d+):\s*(.+)$/gm) ?? []).map((l) => {
    const m = l.match(/^\s*(\d+):\s*(.+)$/);
    return { id: Number(m[1]), desc: m[2].replace(/\s*\[selected\]\s*$/, '') };
  });

const mcp = new McpClient();
try {
  await mcp.start();

  const findExtId = async () => {
    const r = await mcp.call('list_extensions', {});
    for (const line of mcp.text(r).split('\n')) {
      if (line.includes(EXT_NAME)) return (line.match(/id=([a-p]{32})/) ?? [])[1] ?? null;
    }
    return null;
  };
  let extId = await findExtId();
  if (!extId) {
    const r = await mcp.call('install_extension', { path: EXT_PATH }, 60000);
    console.log('install_extension:', mcp.text(r).trim());
    extId = await findExtId();
  }
  await mcp.call('reload_extension', { id: extId }, 60000);
  await sleep(2000);

  const np = mcp.text(await mcp.call('new_page', { url: PROBLEM_URL, timeout: 60000 }, 90000));
  const pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await sleep(4000);

  let panelId = null;
  for (let attempt = 1; attempt <= 3 && panelId == null; attempt++) {
    await mcp.call('trigger_extension_action', { id: extId }, 60000);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && panelId == null) {
      await sleep(1000);
      const lp = mcp.text(await mcp.call('list_pages', {}));
      panelId = pageLines(lp).find(
        (p) => p.desc.includes(`chrome-extension://${extId}`) && p.desc.includes('sidepanel'),
      )?.id ?? null;
    }
  }
  check('side_panel_opened', panelId != null, `pageId=${panelId}`);

  const snapshot = async () => mcp.text(await mcp.call('take_snapshot', { pageId: panelId }, 60000));
  const snapUntil = async (pred, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await snapshot();
      if (pred(s) || Date.now() > deadline) return s;
      await sleep(1000);
    }
  };
  const uidOf = (snap, label) =>
    (snap.split('\n').find((l) => l.includes(label) && /uid=/.test(l))?.match(/\b(?:uid|ref)=([A-Za-z0-9_\-]+)/) ?? [])[1] ?? null;
  const panelEval = async (fn) =>
    unwrap(mcp.text(await mcp.call('evaluate_script', { pageId: panelId, function: fn }, 60000)));
  const reloadPanel = async () => {
    await panelEval(`() => { location.reload(); return 'reloading'; }`).catch(() => null);
    await sleep(2500);
  };
  const settingsSnapshot = async () => {
    const open = uidOf(await snapshot(), 'button "设置"');
    if (!open) return '';
    await mcp.call('click', { pageId: panelId, uid: open }, 60000);
    const opened = await snapUntil((s) => s.includes('dialog "设置"'), 10000);
    const close = uidOf(opened, 'button "关闭"');
    if (close) await mcp.call('click', { pageId: panelId, uid: close }, 60000);
    return opened;
  };

  let snap = await snapUntil((s) => s.includes('计时'));
  writeFileSync(path.join(ARTIFACTS, 'guide-snapshot-loggedin.txt'), snap);
  check('loggedin_no_guidance', !snap.includes('未登录'), 'logged-out banner hidden');
  check('loggedin_problem_ui_visible', snap.includes('计时') && snap.includes('两数之和'), '题目/计时/进度区 shown');
  const accountSnap = await settingsSnapshot();
  check('loggedin_shows_account', accountSnap.includes('已登录') && accountSnap.includes(account.username), account.username);

  const lo = await panelEval(
    `async () => { const r = await fetch('${SITE}/api/auth/logout', { method: 'POST', credentials: 'include' }); return { status: r.status }; }`,
  );
  check('logout_ok', lo?.status === 200, JSON.stringify(lo));
  await reloadPanel();

  snap = await snapUntil((s) => s.includes('未登录，作答不会被记录') && s.includes('去网站登录'));
  writeFileSync(path.join(ARTIFACTS, 'guide-snapshot-loggedout.txt'), snap);
  check('loggedout_shows_unlogin', snap.includes('未登录'), '未登录 label');
  check('loggedout_guidance_hint', snap.includes('作答不会被记录'), 'hint text shown');
  const guideBtn = uidOf(snap, 'button "去网站登录"');
  check('loggedout_register_button', guideBtn != null, `uid=${guideBtn}`);
  check('loggedout_report_ui_hidden', !snap.includes('计时'), '题目/计时/进度区 hidden when logged out');

  const openSiteTab = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await mcp.call('click', { pageId: panelId, uid: guideBtn }, 60000);
      await sleep(2500);
      const lpn = mcp.text(await mcp.call('list_pages', {}));
      const tab = pageLines(lpn).find((p) => p.desc.includes('acbuddy.pages.dev'));
      if (tab) return tab;
      console.log(`  (retry ${attempt}: site tab not open yet)`);
      await sleep(1500);
    }
    return null;
  };
  const siteTab = await openSiteTab();
  check('guide_button_opens_site', siteTab != null, siteTab ? `pageId=${siteTab.id}` : 'no site tab after retries');
  snap = await snapUntil((s) => s.includes('未打开力扣题目'), 35000);
  writeFileSync(path.join(ARTIFACTS, 'guide-snapshot-sitetab.txt'), snap);
  check('panel_follows_active_tab', snap.includes('未打开力扣题目') && !snap.includes('计时'), 'header switched to the non-problem state via tabs.onActivated');

  const li = await panelEval(
    `async () => {
      const r = await fetch('${SITE}/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ${JSON.stringify(account.username)}, password: ${JSON.stringify(account.password)} }),
      });
      return { status: r.status, body: await r.json() };
    }`,
  );
  check('relogin_ok', li?.status === 200 && li?.body?.ok === true, JSON.stringify(li?.body ?? li));
  // bringToFront=true actually activates the tab -> panel's tabs.onActivated fires
  await mcp.call('select_page', { pageId, bringToFront: true }, 60000);
  snap = await snapUntil((s) => s.includes('计时') && s.includes('两数之和'), 20000);
  writeFileSync(path.join(ARTIFACTS, 'guide-snapshot-relogin.txt'), snap);
  check('relogin_no_guidance', !snap.includes('未登录'), 'logged-out banner gone');
  check('relogin_problem_ui_restored', snap.includes('计时'), '题目/计时/进度区 back, no panel reload');
  check('relogin_problem_back', snap.includes('两数之和'), 'problem info re-read after tab switch');
  const reloginAccount = await settingsSnapshot();
  check('relogin_shows_account', reloginAccount.includes(account.username), account.username);

  let conText = '';
  try {
    conText = mcp.text(await mcp.call('list_console_messages', { pageId: panelId }, 60000));
    writeFileSync(path.join(ARTIFACTS, 'guide-console-panel.txt'), conText);
  } catch {
  }
  const errors = conText
    .split('\n')
    .filter((l) => /^\s*\[?error\b|\[ERROR\]/i.test(l))
    .filter((l) => !/Chrome DevTools MCP/i.test(l))
    .filter((l) => !/status of 401/i.test(l));
  check('console_panel_clean', errors.length === 0, errors.join(' | ') || 'no errors');

  const failed = results.filter((r) => !r.pass);
  writeFileSync(
    path.join(ARTIFACTS, 'guide-summary.json'),
    JSON.stringify({ checks: results, pass: failed.length === 0 }, null, 2),
  );
  console.log(`\n== LOGIN GUIDE E2E: ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ==`);
  if (failed.length) console.log(failed.map((f) => `${f.name}: ${f.detail}`).join('\n'));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}
