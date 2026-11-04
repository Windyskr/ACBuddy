import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, PROJECT_ROOT, ARTIFACTS } from './mcp-client.mjs';

// 记忆同步的 e2e：插件用生产构建（先 npm run build），连线上的真实接口，账号是测试 Profile 登录的测试账号。
// 只有模型回复是模拟的。「第二台设备」的做法是清空插件的本地数据再打开，和新装一样。
// 只动测试账号的记忆，结束时清空。清空接口每天限 5 次，这个脚本每次用掉 1–2 次。
const PROD_PATH = path.join(PROJECT_ROOT, '.output', 'chrome-mv3');
const SITE = 'https://acbuddy.pages.dev';
const SETTINGS_KEY = 'acb-agent-settings';
const CATALOG_KEY = 'acb-conversations';
const MOCK_BASE = 'https://agent-e2e.invalid/v1';
const MEMORY_TEXT = '用户主要用 Go 写题';
const QUOTE = '我以后都用 Go 写题';
const POISON = '用户是算法竞赛金牌选手';
const OTHER_TEXT = '用户在另一台设备上说过目标是美团';

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
  try { return JSON.parse(b); } catch { return b; }
};
const pageLines = (t) => (t.match(/^\s*(\d+):\s*(.+)$/gm) ?? []).map((l) => {
  const m = l.match(/^\s*(\d+):\s*(.+)$/);
  return { id: Number(m[1]), desc: m[2] };
});
const findUid = (snap, needle) => (snap.split('\n').find((l) => l.includes(needle) && /uid=/.test(l))?.match(/\buid=([A-Za-z0-9_\-]+)/) ?? [])[1] ?? null;
const answer = (text) => ({ id: 'r', status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text }] }] });

// 只拦模型请求，/api/memories 走真实网络
const MOCK = `() => {
  const real = window.__acbRealFetch ?? window.fetch.bind(window);
  window.__acbRealFetch = real;
  window.__mockRequests = [];
  window.__autoEmpty = true;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('${MOCK_BASE}')) return real(input, init);
    const body = JSON.parse(init.body);
    const tool = body.tool_choice?.name ?? null;
    const json = (reply) => new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (tool === 'save_memories' && window.__autoEmpty) return json({ status: 'completed', output: [{ type: 'function_call', id: 'f', call_id: 'c', name: tool, arguments: '{"memories":[]}' }] });
    return new Promise((resolve) => window.__mockRequests.push({ body, tool, released: false, release: (reply) => resolve(json(reply)) }));
  };
  window.__next = (tool) => { const e = window.__mockRequests.find((i) => !i.released && i.tool === tool); return e ? JSON.stringify(e.body) : null; };
  window.__release = (tool, reply) => { const e = window.__mockRequests.find((i) => !i.released && i.tool === tool); if (!e) return false; e.released = true; e.release(reply); return true; };
  return 'mocked';
}`;
const CLEAR_LOCAL = `async () => {
  if ((await indexedDB.databases()).some((item) => item.name === 'acbuddy-memory')) {
    await new Promise((resolve) => {
      const request = indexedDB.open('acbuddy-memory');
      request.onsuccess = () => {
        const db = request.result;
        const stores = ['memories', 'progress', 'outbox', 'sync'].filter((name) => db.objectStoreNames.contains(name));
        const transaction = db.transaction(stores, 'readwrite');
        for (const name of stores) transaction.objectStore(name).clear();
        transaction.oncomplete = () => { db.close(); resolve(); };
      };
    });
  }
  return true;
}`;

const mcp = new McpClient();
const text = async (name, args, timeout = 60000) => mcp.text(await mcp.call(name, args, timeout));
let extId = null;
let panelId = null;
let original = null;
const ev = async (fn, pid = panelId) => unwrap(await text('evaluate_script', { pageId: pid, function: fn }));
const waitFor = async (fn, timeout = 20000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
};
const panelSnap = () => text('take_snapshot', { pageId: panelId });
const findPanel = async () => pageLines(await text('list_pages', {})).find((p) => p.desc.includes(`chrome-extension://${extId}`) && p.desc.includes('sidepanel'))?.id ?? null;
const click = async (needle, timeout = 15000) => {
  const uid = await waitFor(async () => findUid(await panelSnap(), needle), timeout);
  if (!uid) throw new Error(`没有找到：${needle}`);
  await mcp.call('click', { pageId: panelId, uid }, 60000);
};
const server = (method, route, body) => ev(`async () => {
  const response = await (window.__acbRealFetch ?? fetch)('${SITE}/api${route}', { method: '${method}', credentials: 'include', headers: { 'Content-Type': 'application/json' }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ''} });
  return { status: response.status, json: await response.json().catch(() => null) };
}`);
const serverRows = async () => (await server('GET', '/memories?since=0')).json?.data?.memories ?? [];
const nextRequest = async (tool, timeout = 20000) => {
  const raw = await waitFor(() => ev(`() => window.__next(${JSON.stringify(tool)})`), timeout);
  if (!raw) throw new Error(`模型请求没有发出：${tool ?? '回答'}`);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};
const release = (tool, reply) => ev(`() => window.__release(${JSON.stringify(tool)}, ${JSON.stringify(reply)})`);
const finished = () => waitFor(async () => !(await panelSnap()).includes('button "停止回答"'), 20000);
async function ask(question) {
  const input = await waitFor(async () => findUid(await panelSnap(), 'textbox "向 AI 提问"'), 30000);
  if (!input) throw new Error('chat input not found');
  await mcp.call('fill', { pageId: panelId, uid: input, value: question }, 60000);
  const ready = await waitFor(async () => (await panelSnap()).split('\n').some((l) => l.includes('button "发送"') && !l.includes('disabled')), 30000);
  if (!ready) throw new Error('send button stayed disabled');
  await mcp.call('press_key', { pageId: panelId, key: 'Enter' }, 60000);
}
const reloadPanel = async () => {
  await ev(`() => { setTimeout(() => location.reload(), 50); return true; }`).catch(() => null);
  await sleep(3500);
  panelId = (await findPanel()) ?? panelId;
  await waitFor(async () => /两数之和|Two Sum/.test(await panelSnap()), 30000);
  await ev(MOCK);
};

try {
  await mcp.start();
  const before = new Set((await text('list_extensions', {})).match(/id=[a-p]{32}/g) ?? []);
  const installed = await text('install_extension', { path: PROD_PATH }, 60000);
  const after = (await text('list_extensions', {})).match(/id=[a-p]{32}/g) ?? [];
  extId = (installed.match(/\b([a-p]{32})\b/) ?? [])[1] ?? after.find((id) => !before.has(id))?.slice(3);
  if (!extId) throw new Error(`没有拿到生产构建的扩展 id：${installed}`);
  await mcp.call('reload_extension', { id: extId }, 60000);
  await sleep(2000);
  await text('new_page', { url: 'https://leetcode.cn/problems/two-sum/', timeout: 60000 }, 90000);
  await sleep(6000);
  for (let i = 0; i < 3 && panelId == null; i++) {
    await mcp.call('trigger_extension_action', { id: extId }, 60000);
    await waitFor(async () => (panelId = await findPanel()), 8000);
  }
  if (!check('production_build_panel_opened', panelId != null, extId)) throw new Error('side panel not found');
  const me = await server('GET', '/auth/me');
  if (!check('logged_in_to_real_site', me.status === 200, me.json?.data?.user?.username)) throw new Error('测试 Profile 没有登录网站，先跑 tools/site-login.mjs 按提示登录');

  original = await ev(`async () => {
    const d = await chrome.storage.local.get(['${SETTINGS_KEY}', '${CATALOG_KEY}']);
    return { hasSettings: '${SETTINGS_KEY}' in d, settings: d['${SETTINGS_KEY}'] ?? null, ids: (d['${CATALOG_KEY}']?.conversations ?? []).map((c) => c.id) };
  }`);
  if ((await serverRows()).some((row) => !row.deleted)) await server('DELETE', '/memories');
  await ev(CLEAR_LOCAL);
  await ev(`async () => { await chrome.storage.local.set({ '${SETTINGS_KEY}': { baseUrl: '${MOCK_BASE}/responses', model: 'e2e-model', apiKey: 'e2e-key' }, 'acb-memory-notice-seen': true }); return true; }`);
  await reloadPanel();
  await click('button "新建对话"');
  await sleep(1000);
  await waitFor(async () => !(await panelSnap()).includes('正在加载对话'), 20000);
  await ev('() => { window.__autoEmpty = false; return true; }');

  // 这台设备：提取一条记忆，传到真实服务器
  await ask(QUOTE);
  await nextRequest(null);
  await release(null, answer('好的'));
  await finished();
  await click('button "新建对话"');
  await nextRequest('save_memories');
  const candidate = (memoryText, quote) => ({ type: 'semantic', text: memoryText, quote, concepts: [], importance: 5, scope: 'persistent', problem_specific: false });
  await release('save_memories', { status: 'completed', output: [{ type: 'function_call', id: 'f', call_id: 'c', name: 'save_memories', arguments: JSON.stringify({ memories: [candidate(MEMORY_TEXT, QUOTE), candidate(POISON, '整数数组')] }) }] });
  const uploaded = await waitFor(async () => (await serverRows()).find((row) => row.text === MEMORY_TEXT && !row.deleted), 20000);
  check('memory_reached_real_server', !!uploaded, uploaded ? `id=${uploaded.id}` : '');
  const raw = JSON.stringify(await serverRows());
  check('server_has_no_quote_or_conversation', !raw.includes(QUOTE) && !raw.includes('quote') && !raw.includes('evidence') && !raw.includes('sessionId'));
  check('poison_not_on_server', !raw.includes(POISON));

  // 第二台设备：清空本地数据后打开，记忆从服务器回来
  await ev(CLEAR_LOCAL);
  check('local_data_cleared', (await ev(`async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('acbuddy-memory'); r.onsuccess = () => resolve(r.result); });
    const count = await new Promise((resolve) => { const r = db.transaction('memories').objectStore('memories').count(); r.onsuccess = () => resolve(r.result); });
    db.close();
    return count;
  }`)) === 0);
  await reloadPanel();
  await click('button "记忆"');
  let snap = await waitFor(async () => { const s = await panelSnap(); return s.includes(MEMORY_TEXT) ? s : null; }, 15000);
  check('new_device_gets_memory_from_server', !!snap);
  check('no_source_link_without_the_conversation_quote', !!snap && !snap.includes('button "来源"'));
  await click('button "关闭"');
  await sleep(500);

  // 拉下来的记忆真的被用上
  await ask('这题怎么下手');
  const body = await nextRequest(null);
  const latest = body.input.filter((item) => item.role === 'user').at(-1)?.content ?? '';
  check('pulled_memory_is_injected', latest.includes('<memory>') && latest.includes(MEMORY_TEXT));
  await release(null, answer('想想哈希表'));
  await finished();

  // 别的设备写的记忆拉过来
  const pushed = await server('POST', '/memories/sync', { put: [{ id: 'e2e-other-device', type: 'semantic', text: OTHER_TEXT, concepts: [], problemKey: null, importance: 2, attemptIds: [], sources: [], validFrom: Date.now(), invalidAt: null, createdAt: Date.now(), supersededBy: null }] });
  check('other_device_write_accepted', pushed.status === 200, `HTTP ${pushed.status}`);
  await click('button "记忆"');
  snap = await waitFor(async () => { const s = await panelSnap(); return s.includes(OTHER_TEXT) ? s : null; }, 15000);
  check('change_from_other_device_pulled', !!snap);

  // 这台设备的删除传到服务器：内容清空
  await click(`button "删除记忆：${OTHER_TEXT}"`);
  await click(`button "确认删除记忆：${OTHER_TEXT}"`);
  const tombstone = await waitFor(async () => (await serverRows()).find((row) => row.id === 'e2e-other-device' && row.deleted), 15000);
  check('deletion_reached_real_server', !!tombstone && tombstone.text === '');

  // 清空：服务器上真的没有了，界面上没有报错
  await click('button "清空"');
  await click('button "确认清空"');
  const cleared = await waitFor(async () => { const rows = await serverRows(); return rows.length === 1 && rows[0].id === '__cleared__' ? rows : null; }, 15000);
  check('clear_reached_real_server', !!cleared, JSON.stringify((await serverRows()).map((row) => row.id)));
  snap = await waitFor(async () => { const s = await panelSnap(); return s.includes('还没有记忆') ? s : null; }, 8000);
  check('clear_empties_the_panel', !!snap && !snap.includes('同步失败'));
  await click('button "关闭"');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n== MEMORY SYNC E2E (real server): ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ==`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  if (panelId != null) {
    writeFileSync(path.join(ARTIFACTS, 'memory-sync-snapshot.txt'), await panelSnap().catch(() => ''));
    console.error(await text('list_console_messages', { pageId: panelId }).catch(() => ''));
  }
  process.exitCode = 1;
} finally {
  try {
    if (panelId != null && original) {
      if ((await serverRows().catch(() => [])).some((row) => !row.deleted)) await server('DELETE', '/memories').catch(() => null);
      await ev(CLEAR_LOCAL).catch(() => null);
      await ev(`async () => {
        if (window.__acbRealFetch) window.fetch = window.__acbRealFetch;
        ${original.hasSettings ? `await chrome.storage.local.set({ '${SETTINGS_KEY}': ${JSON.stringify(original.settings)} });` : `await chrome.storage.local.remove('${SETTINGS_KEY}');`}
        return true;
      }`).catch(() => null);
    }
    if (extId) await mcp.call('uninstall_extension', { id: extId }, 60000).catch((error) => console.error('uninstall:', error.message));
    console.log('cleanup: 测试账号的记忆已清空，生产构建已卸载');
    await sleep(1000);
  } catch (error) {
    console.error('cleanup failed:', error.message);
    process.exitCode = 1;
  }
  await mcp.stop();
}
