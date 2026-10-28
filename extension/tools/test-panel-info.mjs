import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

const EXT_NAME = 'ACBuddy';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

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
  // Persistent profile + path-derived extension id: Chrome may serve a stale cached SW script — always reload.
  await mcp.call('reload_extension', { id: extId }, 60000);
  await sleep(2000);

  const np = mcp.text(
    await mcp.call('new_page', { url: 'https://leetcode.cn/problems/two-sum/' }, 90000),
  );
  const pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await sleep(4000);

  await mcp.call('trigger_extension_action', { id: extId }, 60000);
  await sleep(1500);
  const lp = mcp.text(await mcp.call('list_pages', {}));
  const panelLine = pageLines(lp).find(
    (p) => p.desc.includes(`chrome-extension://${extId}`) && p.desc.includes('sidepanel'),
  );
  const panelId = panelLine?.id ?? null;
  check('side_panel_opened', panelId != null, `pageId=${panelId}`);

  const snapshot = async () => mcp.text(await mcp.call('take_snapshot', { pageId: panelId }, 60000));
  let snap = await snapshot();
  const deadline = Date.now() + 20000;
  while (!snap.includes('两数之和') && Date.now() < deadline) {
    await sleep(1000);
    snap = await snapshot();
  }
  writeFileSync(path.join(ARTIFACTS, 'panel-info-snapshot.txt'), snap);
  check('panel_shows_title', snap.includes('两数之和'), 'translatedTitle in panel');
  check('panel_shows_difficulty_cn', snap.includes('简单'), 'difficultyCn in panel');
  check('panel_shows_question_id', snap.includes('StaticText "1. "'), 'questionId in panel');

  const failed = results.filter((r) => !r.pass);
  writeFileSync(
    path.join(ARTIFACTS, 'panel-info-summary.json'),
    JSON.stringify({ checks: results, pass: failed.length === 0 }, null, 2),
  );
  console.log(`\n== PANEL INFO TEST: ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ==`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}

function pageLines(text) {
  return (text.match(/^\s*(\d+):\s*(.+)$/gm) ?? []).map((l) => {
    const m = l.match(/^\s*(\d+):\s*(.+)$/);
    return { id: Number(m[1]), desc: m[2].replace(/\s*\[selected\]\s*$/, '') };
  });
}
