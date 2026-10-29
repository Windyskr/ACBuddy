import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

// 多平台 e2e：在 codefun2000、牛客（核心代码模式、ACM 模式）和力扣的真实题目页上，检查侧边栏顶栏、
// 新对话读到的题目信息、AI 读代码和标出错误行。模型回复是模拟的，不运行、不提交。
// codefun2000 的题面要登录才能看：profile 需先登录。改过的编辑器代码、AI 配置和新建的对话结束时都会还原。
const EXT_NAME = 'ACBuddy';
const SETTINGS_KEY = 'acb-agent-settings';
const CATALOG_KEY = 'acb-conversations';
const MOCK_BASE = 'https://agent-e2e.invalid/v1';
const CODE = 'line one\nline two\nline three';
const CASES = [
  {
    name: 'codefun', key: 'codefun:P1559', url: 'https://codefun2000.com/ide/P1559', editor: 'monaco',
    header: 'P1559 第2题-穿越魔法回廊', difficulty: '难度 3',
    expect: ['平台：CodeFun2000', '题目：P1559 第2题-穿越魔法回廊', '难度：3', '答题模式：ACM 模式', '标签：动态规划', '来源：京东', '时间限制：1 秒', '# 输入描述', '## 样例1'],
    // 页面数据里带着题解，题目信息里不能有
    forbid: ['斐波那契的变种'],
  },
  {
    name: 'nowcoder-core', key: 'nowcoder:75e878df47f24fdc9dc3e400ec6058ca', url: 'https://www.nowcoder.com/practice/75e878df47f24fdc9dc3e400ec6058ca', editor: 'nowcoder',
    header: '反转链表', difficulty: '简单',
    expect: ['平台：牛客', '题目：反转链表', '答题模式：核心代码模式', '标签：链表', '$0\\leq n\\leq1000$', '样例 1', '{1,2,3}', '{3,2,1}'],
    forbid: ['[object Object]'],
  },
  {
    name: 'nowcoder-acm', key: 'nowcoder:8c949ea5f36f422594b306a2300315da', url: 'https://www.nowcoder.com/practice/8c949ea5f36f422594b306a2300315da', editor: 'nowcoder',
    header: '字符串最后一个单词的长度', difficulty: '简单',
    expect: ['答题模式：ACM 模式', '时间限制：1 秒', '内存限制：32 MB', '输入描述：', '输出描述：', '样例 2', '说明：', 'HelloNowcoder'],
    forbid: ['\\hspace', '<img'],
  },
];

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
    return { id: Number(m[1]), desc: m[2] };
  });
const findUid = (snap, needle) =>
  (snap.split('\n').find((l) => l.includes(needle) && /uid=/.test(l))?.match(/\buid=([A-Za-z0-9_\-]+)/) ?? [])[1] ?? null;
const toolCall = (n, name, args = {}) => ({
  id: `resp_${n}`, status: 'completed',
  output: [{ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args) }],
});
const answer = (n, text) => ({
  id: `resp_${n}`, status: 'completed',
  output: [{ type: 'message', id: `msg_${n}`, role: 'assistant', content: [{ type: 'output_text', text }] }],
});
const MOCK = `() => {
  const real = window.__acbRealFetch ?? window.fetch.bind(window);
  window.__acbRealFetch = real;
  window.__mockRequests = [];
  window.__gates = [];
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('${MOCK_BASE}')) return real(input, init);
    const entry = { released: null, body: typeof init.body === 'string' ? init.body : null };
    window.__mockRequests.push(entry);
    return new Promise((resolve) => window.__gates.push({ entry, release: (reply) => {
      entry.released = Date.now();
      resolve(new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    } }));
  };
  window.__release = (reply) => { const g = window.__gates.find((x) => !x.entry.released); if (!g) return false; g.release(reply); return true; };
  return 'mocked';
}`;
// 页面里的编辑器：codefun2000、力扣用全局 monaco，牛客用它自己打包的那份
const EDITOR = {
  monaco: `(window.monaco?.editor.getEditors?.() ?? []).find((e) => { const r = e.getDomNode()?.getBoundingClientRect(); return e.getModel() && r && r.width > 20 && r.height > 20; })`,
  nowcoder: 'window.__ncMonacoEditorApi?.editor',
};

const mcp = new McpClient();
const text = async (name, args, timeout = 60000) => mcp.text(await mcp.call(name, args, timeout));
let extId = null;
let pageId = null;
let panelId = null;
let original = null;
const restoreCode = [];
const ev = async (fn, pid) => unwrap(await text('evaluate_script', { pageId: pid, function: fn }));
const waitFor = async (fn, timeout = 20000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
};
const panelSnap = () => text('take_snapshot', { pageId: panelId });
const findPanel = async () =>
  pageLines(await text('list_pages', {})).find((p) => p.desc.includes(`chrome-extension://${extId}`) && p.desc.includes('sidepanel'))?.id ?? null;
const conversationFor = (key) => ev(`async () => {
  const cat = (await chrome.storage.local.get('${CATALOG_KEY}'))['${CATALOG_KEY}'];
  const item = cat?.conversations?.find((c) => c.key === ${JSON.stringify(key)});
  if (!item) return null;
  const record = (await chrome.storage.local.get('acb-conversation:' + item.id))['acb-conversation:' + item.id];
  // 题面里有 Markdown 代码块（\`\`\`），编码后再传出来，免得和 evaluate_script 输出的代码块混在一起
  return { id: item.id, problemTitle: item.problemTitle, problemUrl: item.problemUrl, problem: encodeURIComponent(record?.messages?.[0]?.content ?? '') };
}`, panelId).then((conv) => (conv && typeof conv === 'object' ? { ...conv, problem: decodeURIComponent(conv.problem) } : null));

let modelRequests = 0;
const release = async (reply) => {
  const n = ++modelRequests;
  const arrived = await waitFor(async () => (await ev('() => window.__mockRequests.length', panelId)) >= n, 20000);
  if (!arrived) throw new Error(`model request ${n} never arrived`);
  await ev(`() => window.__release(${JSON.stringify(reply)})`, panelId);
  return n;
};
const toolOutput = async (callN) => {
  const arrived = await waitFor(async () => (await ev('() => window.__mockRequests.length', panelId)) > modelRequests, 20000);
  if (!arrived) throw new Error(`no model request after tool call ${callN}`);
  return ev(`() => {
    const body = JSON.parse(window.__mockRequests[${modelRequests}].body ?? '{}');
    const item = (body.input ?? []).find((x) => x.type === 'function_call_output' && x.call_id === 'call_${callN}');
    return item ? JSON.parse(item.output) : null;
  }`, panelId);
};
async function ask(question, tools) {
  const input = await waitFor(async () => findUid(await panelSnap(), 'textbox "向 AI 提问"'), 30000);
  if (!input) throw new Error('chat input not found');
  await mcp.call('click', { pageId: panelId, uid: input }, 60000);
  await mcp.call('fill', { pageId: panelId, uid: input, value: question }, 60000);
  // 题目信息加载完之前「发送」是禁用的，按 Enter 也发不出去
  const ready = await waitFor(async () => (await panelSnap()).split('\n').some((l) => l.includes('button "发送"') && !l.includes('disabled')), 30000);
  if (!ready) throw new Error('send button stayed disabled');
  await mcp.call('press_key', { pageId: panelId, key: 'Enter' }, 60000);
  const outputs = [];
  for (const [name, args] of tools) {
    const n = await release(toolCall(modelRequests + 1, name, args));
    outputs.push(await toolOutput(n));
  }
  await release(answer(modelRequests + 1, '好的'));
  await waitFor(async () => !(await panelSnap()).includes('button "停止回答"'), 20000);
  return outputs;
}
async function openProblem(url) {
  await mcp.call('navigate_page', { pageId, type: 'url', url, timeout: 60000 }, 90000);
  await sleep(6000);
  for (let i = 0; i < 3; i++) {
    const s = await text('take_snapshot', { pageId });
    const skip = findUid(s, 'button "跳过"') ?? findUid(s, 'button "Skip"');
    if (!skip) break;
    await mcp.call('click', { pageId, uid: skip }, 60000);
    await sleep(1200);
  }
}

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
  const np = await text('new_page', { url: 'about:blank', timeout: 60000 }, 90000);
  pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await openProblem(CASES[0].url);
  for (let i = 0; i < 3 && panelId == null; i++) {
    await mcp.call('trigger_extension_action', { id: extId }, 60000);
    await waitFor(async () => (panelId = await findPanel()), 8000);
  }
  if (!check('side_panel_opened', panelId != null)) throw new Error('side panel not found');
  original = await ev(`async () => {
    const d = await chrome.storage.local.get(['${SETTINGS_KEY}', '${CATALOG_KEY}']);
    return { hasSettings: '${SETTINGS_KEY}' in d, settings: d['${SETTINGS_KEY}'] ?? null, ids: (d['${CATALOG_KEY}']?.conversations ?? []).map((c) => c.id) };
  }`, panelId);
  await ev(`async () => {
    await chrome.storage.local.set({ '${SETTINGS_KEY}': { baseUrl: '${MOCK_BASE}', model: 'e2e-model', apiKey: 'e2e-key', apiType: 'responses' } });
    setTimeout(() => location.reload(), 50);
    return true;
  }`, panelId).catch(() => null);
  await sleep(3500);
  panelId = (await findPanel()) ?? panelId;
  await ev(MOCK, panelId);

  for (const [index, c] of CASES.entries()) {
    if (index > 0) await openProblem(c.url);
    const header = await waitFor(async () => {
      const snap = await panelSnap();
      return snap.includes(c.header) ? snap : null;
    }, 30000);
    check(`${c.name}_header`, !!header && header.includes(c.difficulty), c.header);
    check(`${c.name}_no_timer_or_banner`, !!header && !header.includes('计时') && !header.includes('作答不会被记录'));
    const conv = await waitFor(() => conversationFor(c.key), 30000);
    writeFileSync(path.join(ARTIFACTS, `platform-${c.name}-problem.txt`), conv?.problem ?? '');
    const missing = c.expect.filter((s) => !conv?.problem.includes(s));
    const leaked = c.forbid.filter((s) => conv?.problem.includes(s));
    check(`${c.name}_problem_message`, !!conv && !missing.length && !leaked.length, `missing=${JSON.stringify(missing)} leaked=${JSON.stringify(leaked)}`);
    check(`${c.name}_problem_url`, conv?.problemUrl === c.url, conv?.problemUrl);

    const editor = EDITOR[c.editor];
    restoreCode.push({ url: c.url, editor, code: await ev(`() => ${editor}?.getModel()?.getValue() ?? null`, pageId) });
    const set = await ev(`() => { const e = ${editor}; if (!e) return false; e.getModel().setValue(${JSON.stringify(CODE)}); return true; }`, pageId);
    if (!check(`${c.name}_editor_found`, set === true)) continue;
    const [code, highlighted] = await ask('帮我看看第 2 行', [
      ['get_code'],
      ['highlight_errors', { ranges: [{ startLine: 2, endLine: 2, message: '这里有问题' }] }],
    ]);
    check(`${c.name}_get_code`, code?.code === CODE, JSON.stringify(code).slice(0, 120));
    check(`${c.name}_highlight`, highlighted?.highlighted === 1, JSON.stringify(highlighted));
    const marks = await ev(`() => {
      const e = ${editor}; const model = e.getModel();
      const deco = model.getAllDecorations().filter((d) => d.options.className === 'acb-agent-error-line');
      return { lines: deco.map((d) => d.range.startLineNumber), hover: deco.some((d) => String(d.options.hoverMessage?.value ?? '').includes('这里有问题')),
        markers: window.monaco?.editor?.getModelMarkers?.({ owner: 'acbuddy-agent' }).length ?? 0 };
    }`, pageId);
    // 全局 monaco 的编辑器另加错误标记（波浪线和悬停说明）；牛客只标红行
    check(`${c.name}_highlight_shown`, marks?.lines?.[0] === 2 && !marks.hover && marks.markers === (c.editor === 'nowcoder' ? 0 : 1), JSON.stringify(marks));
    await ev(`() => { const m = ${editor}.getModel(); m.setValue(m.getValue() + '\\n'); return true; }`, pageId);
    const cleared = await ev(`() => ${editor}.getModel().getAllDecorations().filter((d) => d.options.className === 'acb-agent-error-line').length`, pageId);
    check(`${c.name}_highlight_cleared_on_edit`, cleared === 0, String(cleared));
    const back = restoreCode.at(-1);
    if (back.code != null) await ev(`() => { ${editor}.getModel().setValue(${JSON.stringify(back.code)}); return true; }`, pageId);
    back.done = true;
  }

  // 旧版题目页没有代码框，不算题目页
  await openProblem('https://www.nowcoder.com/questionTerminal/75e878df47f24fdc9dc3e400ec6058ca');
  check('unsupported_page', !!(await waitFor(async () => (await panelSnap()).includes('未打开题目页面'), 15000)));

  // 力扣走原来的路径：顶栏有计时，对话里的题目信息带平台
  await openProblem('https://leetcode.cn/problems/two-sum/');
  const lc = await waitFor(async () => {
    const snap = await panelSnap();
    return snap.includes('1. 两数之和') ? snap : null;
  }, 30000);
  check('leetcode_header', !!lc && lc.includes('简单') && lc.includes('计时'));
  const lcConv = await waitFor(() => conversationFor('leetcode:two-sum'), 30000);
  check('leetcode_problem_message', !!lcConv && lcConv.problem.includes('平台：力扣') && lcConv.problem.includes('题目：1. 两数之和') && lcConv.problem.includes('10^4'),
    (lcConv?.problem ?? '').slice(0, 80));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n== PLATFORMS E2E: ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ==`);
  if (failed.length) console.log(failed.map((f) => `${f.name}: ${f.detail}`).join('\n'));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  if (panelId != null) writeFileSync(path.join(ARTIFACTS, 'platforms-panel-snapshot.txt'), await panelSnap().catch(() => ''));
  process.exitCode = 1;
} finally {
  try {
    for (const item of restoreCode.filter((x) => !x.done && x.code != null)) {
      await mcp.call('navigate_page', { pageId, type: 'url', url: item.url, timeout: 60000 }, 90000).catch(() => null);
      await sleep(5000);
      await ev(`() => { const e = ${item.editor}; if (e) e.getModel().setValue(${JSON.stringify(item.code)}); return !!e; }`, pageId).catch(() => null);
    }
    if (panelId != null && original) {
      const restore = original.hasSettings
        ? `chrome.storage.local.set({ '${SETTINGS_KEY}': ${JSON.stringify(original.settings)} })`
        : `chrome.storage.local.remove('${SETTINGS_KEY}')`;
      const removed = await ev(`async () => {
        if (window.__acbRealFetch) window.fetch = window.__acbRealFetch;
        await ${restore};
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
      }`, panelId);
      console.log(`cleanup: ${removed} conversation(s) removed, AI settings restored, editor code restored`);
    }
    await sleep(1500);
  } catch (error) {
    console.error('cleanup failed:', error.message);
    process.exitCode = 1;
  }
  await mcp.stop();
}
