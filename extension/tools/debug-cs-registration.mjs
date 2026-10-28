import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

const EXT_NAME = 'ACBuddy';
const SITE = 'https://acbuddy.pages.dev/';
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
const swLines = (text) =>
  (text.match(/(sw-\d+):\s*(chrome-extension:\/\/\S+)/g) ?? []).map((l) => {
    const m = l.match(/(sw-\d+):\s*(chrome-extension:\/\/(\S+?))\/(.*?)\s*$/);
    return { swId: m[1], url: m[2], extId: m[3], script: m[4] };
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
    console.log('install:', mcp.text(r).trim());
    extId = await findExtId();
  }
  await mcp.call('reload_extension', { id: extId }, 60000);
  await sleep(3000);

  const lp = mcp.text(await mcp.call('list_pages', {}));
  const sw = swLines(lp).find((s) => s.extId === extId);
  if (!sw) throw new Error('sw not found');
  const swEval = async (fn) =>
    unwrap(mcp.text(await mcp.call('evaluate_script', { serviceWorkerId: sw.swId, function: fn }, 60000)));
  const regs = () =>
    swEval(
      `async () => (await chrome.scripting.getRegisteredContentScripts()).map(r => ({ id: r.id, js: r.js, matches: r.matches }))`,
    );
  const probeActive = () =>
    swEval(`async () => new Promise((res) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab) return res({ err: 'no active tab' });
        chrome.tabs.sendMessage(tab.id, { type: 'GET_PROBLEM_INFO' }, (r) => {
          const e = chrome.runtime.lastError;
          res({ url: tab.url, err: e?.message ?? null, ok: r?.ok ?? null, src: r?.source ?? null });
        });
      });
    })`);

  console.log('T+3s  regs:', JSON.stringify(await regs()));

  await sleep(30000);
  console.log('T+33s regs after idle:', JSON.stringify(await regs()));

  const created = await swEval(
    `async () => (await chrome.tabs.create({ url: '${SITE}' })).id`,
  );
  console.log('ext-created tab id:', created);
  for (const wait of [3000, 5000, 10000]) {
    await sleep(wait);
    console.log(`ext-created tab probe (+${wait / 1000}s):`, JSON.stringify(await probeActive()));
    console.log('  regs:', JSON.stringify(await regs()));
  }

  const np = mcp.text(await mcp.call('new_page', { url: SITE, timeout: 60000 }, 90000));
  const pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await sleep(6000);
  console.log('cdp-created tab probe:', JSON.stringify(await probeActive()));

  writeFileSync(
    path.join(ARTIFACTS, 'cs-registration-debug.json'),
    JSON.stringify({ extCreatedTabId: created, cdpPageId: pageId }, null, 2),
  );
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}
