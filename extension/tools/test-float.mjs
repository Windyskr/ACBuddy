import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

// 悬浮窗模式的 e2e：从侧边栏切到悬浮窗、拖动和调大小、收起成圆钮、按网站分别记位置、工具栏图标显示和收起、
// 回答进行中圆钮转圈和答完的绿点、再停靠回侧边栏。模型是本机起的模拟服务，不提交，结束时还原设置和对话。
const EXT_NAME = 'ACBuddy';
const KEYS = ['acb-agent-settings', 'acb-display-mode', 'acb-float-layout', 'acb-memory-enabled', 'acb-memory-notice-seen'];
const CATALOG_KEY = 'acb-conversations';
const ANSWER = '先存再查会让同一个元素用两次。';

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
const pageLines = (text) => (text.match(/^\s*(\d+):\s*(.+)$/gm) ?? []).map((l) => {
  const m = l.match(/^\s*(\d+):\s*(.+)$/);
  return { id: Number(m[1]), desc: m[2] };
});
const findUid = (snap, needle) =>
  (snap.split('\n').find((l) => l.includes(needle) && /uid=/.test(l))?.match(/\buid=([A-Za-z0-9_\-]+)/) ?? [])[1] ?? null;

// 本机的模拟模型（Responses 格式）：回答前停 6 秒，好在这期间收起窗口看圆钮转圈
const requests = [];
const server = createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    requests.push(body);
    if (!body.stream) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'function_call', id: 'f', call_id: 'c', name: body.tool_choice?.name ?? 'save_memories', arguments: '{"memories":[]}' }] }));
      return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
    setTimeout(() => {
      const output = [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: ANSWER }] }];
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: ANSWER })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`);
    }, 6000);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const MODEL_URL = `http://127.0.0.1:${server.address().port}/v1/responses`;

const mcp = new McpClient();
const text = async (name, args, timeout = 60000) => mcp.text(await mcp.call(name, args, timeout));
let extId = null;
let original = null;
const ev = async (fn, pid) => unwrap(await text('evaluate_script', { pageId: pid, function: fn }));
const waitFor = async (fn, timeout = 20000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
};
const pages = async () => pageLines(await text('list_pages', {}));
const panelPage = async () => (await pages()).find((p) => p.desc.includes(`chrome-extension://${extId}`) && p.desc.includes('sidepanel') && !p.desc.includes('mode=float'))?.id ?? null;
const snap = (pid) => text('take_snapshot', { pageId: pid });
const click = async (pid, needle, timeout = 15000) => {
  const uid = await waitFor(async () => findUid(await snap(pid), needle), timeout);
  if (!uid) throw new Error(`没有找到：${needle}`);
  await mcp.call('click', { pageId: pid, uid }, 60000);
};
/** 插件自己的页面开在标签页里，用来读写 chrome.storage.local（内容脚本和题目页读不到） */
const withExtensionPage = async (fn) => {
  const np = await text('new_page', { url: `chrome-extension://${extId}/sidepanel.html`, timeout: 30000 }, 60000);
  const pid = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  try { return await ev(fn, pid); } finally { await text('close_page', { pageId: pid }).catch(() => null); }
};
const layouts = async () => {
  const raw = await withExtensionPage(`async () => JSON.stringify((await chrome.storage.local.get('acb-float-layout'))['acb-float-layout'] ?? {})`);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};
/** 题目页上悬浮窗的状态（shadow root 是 open 的，页面里读得到；iframe 里的内容读不到） */
const floatState = (pid) => ev(`() => {
  const shadow = document.querySelector('acbuddy-float')?.shadowRoot;
  if (!shadow) return JSON.stringify({ root: false });
  const win = shadow.querySelector('.window');
  const bubble = shadow.querySelector('.bubble');
  const rect = win.getBoundingClientRect();
  const dot = bubble.getBoundingClientRect();
  return JSON.stringify({
    root: true, open: !win.hidden, bubble: !bubble.hidden, busy: bubble.classList.contains('busy'), unread: !shadow.querySelector('.dot').hidden,
    right: Math.round(innerWidth - rect.right), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
    bubbleRight: Math.round(innerWidth - dot.right), bubbleTop: Math.round(dot.top), src: shadow.querySelector('iframe')?.src ?? null,
  });
}`, pid).then((raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw));
/** 在页面里合成指针事件拖 shadow DOM 里的把手（.grip、.resize、.bubble） */
const dragHandle = (pid, selector, dx, dy) => ev(`async () => {
  const el = document.querySelector('acbuddy-float').shadowRoot.querySelector('${selector}');
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const fire = (type, cx, cy) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, clientX: cx, clientY: cy }));
  fire('pointerdown', x, y);
  for (let i = 1; i <= 5; i++) { fire('pointermove', x + ${dx} * i / 5, y + ${dy} * i / 5); await new Promise((r) => setTimeout(r, 30)); }
  fire('pointerup', x + ${dx}, y + ${dy});
  return true;
}`, pid);

let problemPage = null;
try {
  await mcp.start();
  const findExt = async () => {
    for (const line of (await text('list_extensions', {})).split('\n')) {
      if (line.includes(EXT_NAME)) return (line.match(/id=([a-p]{32})/) ?? [])[1] ?? null;
    }
    return null;
  };
  extId = await findExt();
  if (!extId) {
    await mcp.call('install_extension', { path: EXT_PATH }, 60000);
    extId = await findExt();
  }
  await mcp.call('reload_extension', { id: extId }, 60000);
  await sleep(2000);
  // 记下原来的设置和对话，换成侧边栏模式、模拟模型
  original = await withExtensionPage(`async () => {
    const keys = ${JSON.stringify(KEYS)};
    const d = await chrome.storage.local.get([...keys, '${CATALOG_KEY}']);
    const stored = Object.fromEntries(keys.filter((key) => key in d).map((key) => [key, d[key]]));
    await chrome.storage.local.remove(['acb-display-mode', 'acb-float-layout']);
    await chrome.storage.local.set({ 'acb-agent-settings': { baseUrl: '${MODEL_URL}', model: 'mock', apiKey: 'e2e-key' }, 'acb-memory-enabled': false, 'acb-memory-notice-seen': true });
    return JSON.stringify({ stored, ids: (d['${CATALOG_KEY}']?.conversations ?? []).map((c) => c.id) });
  }`);
  original = typeof original === 'string' ? JSON.parse(original) : original;

  const np = await text('new_page', { url: 'https://leetcode.cn/problems/two-sum/', timeout: 60000 }, 90000);
  problemPage = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await sleep(6000);
  let panel = null;
  for (let i = 0; i < 3 && panel == null; i++) {
    await mcp.call('trigger_extension_action', { id: extId }, 60000);
    panel = await waitFor(panelPage, 8000);
  }
  if (!check('side_panel_opened', panel != null)) throw new Error('side panel not found');
  check('no_float_in_sidepanel_mode', !(await floatState(problemPage)).root);

  // 侧边栏 → 悬浮窗
  await waitFor(async () => /两数之和/.test(await snap(panel)), 30000);
  await click(panel, 'button "改成悬浮窗"');
  const closed = await waitFor(async () => (await panelPage()) == null, 10000);
  check('sidepanel_closes', closed);
  let state = await waitFor(async () => { const s = await floatState(problemPage); return s.open ? s : null; }, 10000) ?? {};
  check('float_opens_on_problem_page', state.open && !state.bubble && /sidepanel\.html\?mode=float$/.test(state.src ?? ''), JSON.stringify(state));
  check('float_default_place', state.right === 16 && state.top === 72 && state.width === 380, `right ${state.right} top ${state.top} width ${state.width}`);
  let page = await waitFor(async () => { const s = await snap(problemPage); return /button "停靠到侧边栏"/.test(s) && /两数之和/.test(s.split('Iframe')[1] ?? '') ? s : null; }, 20000) ?? '';
  check('float_panel_bound_to_tab', !!page, '悬浮窗里的面板读到了这个标签页的题目');

  // 拖顶上的把手、拖左下角调大小：都记到 leetcode.cn 名下
  await dragHandle(problemPage, '.grip', -300, 60);
  state = await floatState(problemPage);
  check('drag_moves_window', state.right === 316 && state.top === 132, `right ${state.right} top ${state.top}`);
  await dragHandle(problemPage, '.resize', -100, 80);
  state = await floatState(problemPage);
  check('resize_grows_left_and_down', state.width === 480 && state.height === 720 && state.right === 316 && state.top === 132, `${state.width}×${state.height}`);
  let saved = await layouts();
  check('layout_saved_per_site', saved['leetcode.cn']?.right === 316 && saved['leetcode.cn']?.top === 132 && saved['leetcode.cn']?.width === 480 && saved['leetcode.cn']?.open === true, JSON.stringify(saved));

  // 拖到离右边不到 24 像素：贴上去
  await dragHandle(problemPage, '.grip', 300, 0);
  state = await floatState(problemPage);
  check('snaps_to_edge', state.right === 8, `right ${state.right}`);

  // 顶栏也能拖（指针在 iframe 里，位置发给外面）：用真的鼠标拖题目标题到左边的题目描述上
  page = await snap(problemPage);
  const iframePart = page.split('Iframe')[1] ?? '';
  const title = findUid(iframePart, 'StaticText "1. 两数之和"') ?? findUid(iframePart, '1. 两数之和');
  const target = findUid(page.split('Iframe')[0], '题目描述');
  if (title && target) {
    const before = await floatState(problemPage);
    await mcp.call('drag', { pageId: problemPage, from_uid: title, to_uid: target }, 60000).catch((e) => console.log('drag:', e.message));
    await sleep(800);
    const after = await floatState(problemPage);
    check('header_drag_moves_window', after.right > before.right + 100, `right ${before.right} → ${after.right}`);
  } else check('header_drag_moves_window', false, `title ${title} target ${target}`);
  await dragHandle(problemPage, '.grip', 2000, -2000);
  state = await floatState(problemPage);

  // 回答进行中：停靠按钮不能点；收起后圆钮转圈，答完出现绿点，展开后绿点消失。新建一个对话来问，结束时删掉
  await click(problemPage, 'button "新建对话"');
  await sleep(1500);
  page = await waitFor(async () => { const s = await snap(problemPage); return /思路提示/.test(s) ? s : null; }, 15000) ?? await snap(problemPage);
  const input = findUid(page, 'textbox "向 AI 提问"');
  await mcp.call('click', { pageId: problemPage, uid: input }, 60000);
  await mcp.call('fill', { pageId: problemPage, uid: input, value: '帮我看看代码哪里错了' }, 60000);
  await mcp.call('press_key', { pageId: problemPage, key: 'Enter' }, 60000);
  page = await waitFor(async () => { const s = await snap(problemPage); return /button "停靠到侧边栏"[^\n]*disabled/.test(s) ? s : null; }, 8000);
  check('dock_disabled_while_answering', !!page);
  await click(problemPage, 'button "收起"');
  state = await waitFor(async () => { const s = await floatState(problemPage); return s.bubble ? s : null; }, 5000) ?? {};
  check('collapse_to_bubble', state.bubble && !state.open);
  check('bubble_spins_while_answering', state.busy, JSON.stringify({ busy: state.busy, requests: requests.length }));
  state = await waitFor(async () => { const s = await floatState(problemPage); return s.unread ? s : null; }, 15000) ?? {};
  check('bubble_dot_after_answer', state.unread && !state.busy);
  saved = await layouts();
  check('collapsed_state_saved', saved['leetcode.cn']?.open === false);

  // 圆钮拖到页面中间（左移、上移都行），位置也按网站记；点一下展开，绿点消失，回答在里面
  const bubbleBefore = { right: state.bubbleRight, top: state.bubbleTop };
  await dragHandle(problemPage, '.bubble', -400, -120);
  state = await floatState(problemPage);
  check('bubble_drag_anywhere', state.bubble && state.bubbleRight === bubbleBefore.right + 400 && state.bubbleTop === bubbleBefore.top - 120,
    `${bubbleBefore.right}/${bubbleBefore.top} → ${state.bubbleRight}/${state.bubbleTop}`);
  saved = await layouts();
  check('bubble_position_saved', saved['leetcode.cn']?.bubbleRight === state.bubbleRight && saved['leetcode.cn']?.bubbleTop === state.bubbleTop);
  await ev(`() => { document.querySelector('acbuddy-float').shadowRoot.querySelector('.bubble').click(); return true; }`, problemPage);
  state = await floatState(problemPage);
  check('bubble_click_expands', state.open && !state.bubble && !state.unread);
  check('answer_kept_in_window', (await snap(problemPage)).includes(ANSWER));

  // 刷新页面：按记下的位置和展开状态恢复
  saved = await layouts();
  await mcp.call('navigate_page', { pageId: problemPage, type: 'reload', timeout: 60000 }, 90000).catch(() => null);
  state = await waitFor(async () => { const s = await floatState(problemPage); return s.root ? s : null; }, 20000) ?? {};
  const remembered = saved['leetcode.cn'] ?? {};
  check('restores_after_reload', state.open === true && state.right === remembered.right && state.top === remembered.top && state.width === remembered.width,
    `now ${state.right}/${state.top}/${state.width}, saved ${remembered.right}/${remembered.top}/${remembered.width}`);

  // 工具栏图标：悬浮窗模式下收起和展开
  await mcp.call('select_page', { pageId: problemPage }, 60000).catch(() => null);
  await mcp.call('trigger_extension_action', { id: extId }, 60000);
  state = await waitFor(async () => { const s = await floatState(problemPage); return s.bubble ? s : null; }, 5000) ?? {};
  check('toolbar_collapses', state.bubble && !state.open);
  check('bubble_restored_after_reload', state.bubbleRight === remembered.bubbleRight && state.bubbleTop === remembered.bubbleTop,
    `now ${state.bubbleRight}/${state.bubbleTop}, saved ${remembered.bubbleRight}/${remembered.bubbleTop}`);
  await mcp.call('trigger_extension_action', { id: extId }, 60000);
  state = await waitFor(async () => { const s = await floatState(problemPage); return s.open ? s : null; }, 5000) ?? {};
  check('toolbar_expands', state.open && !state.bubble);
  check('no_sidepanel_in_float_mode', (await panelPage()) == null);

  // 另一个网站单独记：力扣国际版第一次打开用默认位置
  const other = await text('new_page', { url: 'https://leetcode.com/problems/two-sum/', timeout: 60000 }, 90000);
  const otherPage = Number((other.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  state = await waitFor(async () => { const s = await floatState(otherPage); return s.root ? s : null; }, 20000) ?? {};
  check('other_site_default', state.root && state.bubble && !state.open && state.right !== remembered.right, JSON.stringify({ open: state.open, bubble: state.bubble }));
  await ev(`() => { document.querySelector('acbuddy-float').shadowRoot.querySelector('.bubble').click(); return true; }`, otherPage);
  await dragHandle(otherPage, '.grip', -200, 40);
  saved = await layouts();
  check('sites_kept_apart', saved['leetcode.com']?.right === 216 && saved['leetcode.cn']?.right === remembered.right, JSON.stringify(Object.keys(saved)));
  await text('close_page', { pageId: otherPage }).catch(() => null);

  // 停靠回侧边栏：悬浮窗拿掉，侧边栏打开
  await mcp.call('select_page', { pageId: problemPage }, 60000).catch(() => null);
  await click(problemPage, 'button "停靠到侧边栏"');
  state = await waitFor(async () => { const s = await floatState(problemPage); return s.root ? null : s; }, 8000) ?? { root: true };
  check('dock_removes_float', !state.root);
  check('dock_opens_sidepanel', !!(await waitFor(panelPage, 8000)));
  const mode = await withExtensionPage(`async () => (await chrome.storage.local.get('acb-display-mode'))['acb-display-mode'] ?? 'unset'`);
  check('mode_saved_sidepanel', mode === 'sidepanel', String(mode));

  await text('take_screenshot', { pageId: problemPage, filePath: path.join(ARTIFACTS, 'float-final.png') }).catch(() => null);
  const errors = await text('list_console_messages', { pageId: problemPage, types: ['error'] }).catch(() => '');
  const ours = errors.split('\n').filter((line) => /acbuddy|chrome-extension/i.test(line));
  check('no_extension_errors_on_page', !ours.length, ours.slice(0, 3).join(' | '));
  writeFileSync(path.join(ARTIFACTS, 'float-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((item) => !item.pass);
  console.log(failed.length ? `\n== FLOAT E2E: ${failed.length} FAILED ==` : '\n== FLOAT E2E: ALL PASS ==');
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error('FATAL', error.message);
  process.exitCode = 1;
} finally {
  try {
    if (extId && original) {
      const removed = await withExtensionPage(`async () => {
        const stored = ${JSON.stringify(original.stored)};
        await chrome.storage.local.remove(${JSON.stringify(KEYS)}.filter((key) => !(key in stored)));
        await chrome.storage.local.set(stored);
        const keep = new Set(${JSON.stringify(original.ids)});
        return navigator.locks.request('${CATALOG_KEY}', async () => {
          const cat = (await chrome.storage.local.get('${CATALOG_KEY}'))['${CATALOG_KEY}'] ?? { conversations: [], selected: {} };
          const removed = cat.conversations.filter((c) => !keep.has(c.id)).map((c) => c.id);
          cat.conversations = cat.conversations.filter((c) => keep.has(c.id));
          for (const [key, id] of Object.entries(cat.selected)) {
            if (keep.has(id)) continue;
            const next = cat.conversations.find((c) => c.key === key);
            if (next) cat.selected[key] = next.id;
            else delete cat.selected[key];
          }
          await chrome.storage.local.set({ '${CATALOG_KEY}': cat });
          await chrome.storage.local.remove(removed.map((id) => 'acb-conversation:' + id));
          return removed.length;
        });
      }`);
      console.log(`cleanup: ${removed} conversation(s) removed, settings and display mode restored`);
    }
    await sleep(1000);
  } catch (error) {
    console.error('cleanup failed:', error.message);
    process.exitCode = 1;
  }
  await mcp.stop();
  server.close();
}
