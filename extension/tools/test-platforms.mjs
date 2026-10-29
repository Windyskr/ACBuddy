import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

// 多平台 e2e：在 codefun2000、牛客（核心代码模式、ACM 模式）、洛谷、AtCoder、AcWing 和力扣的真实题目页上，
// 检查侧边栏顶栏、新对话读到的题目信息、模型拿到的工具、AI 读代码和标出错误行。模型回复是模拟的，不运行、不提交。
// codefun2000、洛谷 IDE、AtCoder 提交区和 AcWing 都要登录：profile 需先登录。改过的代码、AI 配置和新建的对话结束时都会还原。
const EXT_NAME = 'ACBuddy';
const SETTINGS_KEY = 'acb-agent-settings';
const CATALOG_KEY = 'acb-conversations';
const MOCK_BASE = 'https://agent-e2e.invalid/v1';
const CODE = 'line one\nline two\nline three';
const FULL = ['get_code', 'highlight_errors', 'clear_highlights'];
const CASES = [
  {
    name: 'codefun', key: 'codefun:P1559', url: 'https://codefun2000.com/ide/P1559', editor: 'monaco', tools: FULL,
    header: 'P1559 第2题-穿越魔法回廊', difficulty: '难度 3',
    expect: ['平台：CodeFun2000', '题目：P1559 第2题-穿越魔法回廊', '难度：3', '答题模式：ACM 模式', '标签：动态规划', '来源：京东', '时间限制：1 秒', '# 输入描述', '## 样例1'],
    // 页面数据里带着题解，题目信息里不能有
    forbid: ['斐波那契的变种'],
  },
  {
    name: 'nowcoder-core', key: 'nowcoder:75e878df47f24fdc9dc3e400ec6058ca', url: 'https://www.nowcoder.com/practice/75e878df47f24fdc9dc3e400ec6058ca', editor: 'nowcoder', tools: FULL,
    header: '反转链表', difficulty: '简单',
    expect: ['平台：牛客', '题目：反转链表', '答题模式：核心代码模式', '标签：链表', '$0\\leq n\\leq1000$', '样例 1', '{1,2,3}', '{3,2,1}'],
    forbid: ['[object Object]'],
  },
  {
    name: 'nowcoder-acm', key: 'nowcoder:8c949ea5f36f422594b306a2300315da', url: 'https://www.nowcoder.com/practice/8c949ea5f36f422594b306a2300315da', editor: 'nowcoder', tools: FULL,
    header: '字符串最后一个单词的长度', difficulty: '简单',
    expect: ['答题模式：ACM 模式', '时间限制：1 秒', '内存限制：32 MB', '输入描述：', '输出描述：', '样例 2', '说明：', 'HelloNowcoder'],
    forbid: ['\\hspace', '<img'],
  },
  {
    // #ide 直接打开 IDE 模式；之后在站内点到 P1421，检查单页换题后读的是新题
    name: 'luogu', key: 'luogu:P1001', url: 'https://www.luogu.com.cn/problem/P1001#ide', editor: 'cm6', tools: ['get_code'],
    header: 'P1001 A+B Problem', difficulty: '入门',
    expect: ['平台：洛谷', '题目：P1001 A+B Problem', '难度：入门', '标签：模拟', '答题模式：ACM 模式', '## 题目描述', '## 输入格式', '样例 1', '20 30', '时间限制：1 秒', '内存限制：512 MB'],
    forbid: ['undefined'],
    // IDE 模式里没有推荐题目的链接，换题要在普通题目页上点
    then: { from: 'https://www.luogu.com.cn/problem/P1001', link: '/problem/P1421', key: 'luogu:P1421', header: 'P1421 小玉买文具', expect: ['题目：P1421 小玉买文具'], forbid: ['A+B Problem'] },
  },
  {
    name: 'atcoder', key: 'atcoder:abc300_a', url: 'https://atcoder.jp/contests/abc300/tasks/abc300_a', editor: 'ace:#editor', tools: FULL,
    header: 'ABC300 A N-choice question', difficulty: null,
    expect: ['平台：AtCoder', '题目：ABC300 A N-choice question', '时间限制：2 秒', '内存限制：1024 MB', 'Problem Statement', 'Constraints', '$N$', '样例 3'],
    forbid: ['Copy', '<var>'],
  },
  {
    name: 'acwing', key: 'acwing:1', url: 'https://www.acwing.com/problem/content/1/', editor: 'ace:#code_editor', tools: FULL,
    header: '1. A + B', difficulty: '简单',
    expect: ['平台：AcWing', '题目：1. A + B', '难度：简单', '答题模式：ACM 模式', '输入样例', '3 4', '$A, B$'],
    forbid: ['𝐴'],
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
// 页面里的代码框：读、写、看 AI 加的标记。codefun2000 用全局 monaco，牛客用它自己那份，AtCoder、AcWing 是 Ace，洛谷 IDE 是 CodeMirror 6
const MONACO = `(window.monaco?.editor.getEditors?.() ?? []).find((e) => { const r = e.getDomNode()?.getBoundingClientRect(); return e.getModel() && r && r.width > 20 && r.height > 20; })`;
const monacoLike = (editor, markers) => ({
  get: `${editor}?.getModel()?.getValue() ?? null`,
  set: (code) => `(() => { const e = ${editor}; if (!e) return false; e.getModel().setValue(${JSON.stringify(code)}); return true; })()`,
  touch: `(() => { const m = ${editor}.getModel(); m.setValue(m.getValue() + '\\n'); return true; })()`,
  // 全局 monaco 的编辑器另加错误标记；牛客只标红行
  marks: `(() => { const m = ${editor}.getModel(); return { lines: m.getAllDecorations().filter((d) => d.options.className === 'acb-agent-error-line').map((d) => d.range.startLineNumber), markers: ${markers ? "window.monaco.editor.getModelMarkers({ owner: 'acbuddy-agent' }).length" : '0'} }; })()`,
  expectMarkers: markers ? 1 : 0,
});
const aceAt = (selector) => {
  const editor = `document.querySelector('${selector}')?.env?.editor`;
  return {
    get: `${editor}?.getValue() ?? null`,
    set: (code) => `(() => { const e = ${editor}; if (!e) return false; e.setValue(${JSON.stringify(code)}, -1); return true; })()`,
    touch: `(() => { const e = ${editor}; e.setValue(e.getValue() + '\\n', 1); return true; })()`,
    marks: `(() => { const s = ${editor}.session; return { lines: Object.values(s.getMarkers(false)).filter((m) => m.clazz === 'acb-agent-error-line').map((m) => m.range.start.row + 1), markers: String(s.$decorations?.[1] ?? '').includes('acb-agent-error-gutter') ? 1 : 0 }; })()`,
    expectMarkers: 1,
  };
};
const CM6 = `(() => { const c = document.querySelector('.cm-editor .cm-content'); const t = c?.cmTile ?? c?.cmView; return t?.view ?? t; })()`;
const editorFor = (kind) => kind === 'monaco' ? monacoLike(MONACO, true)
  : kind === 'nowcoder' ? monacoLike('window.__ncMonacoEditorApi?.editor', false)
  : kind === 'cm6' ? {
    get: `${CM6}?.state?.doc?.toString() ?? null`,
    set: (code) => `(() => { const v = ${CM6}; if (!v?.dispatch) return false; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(code)} } }); return true; })()`,
  }
  : kind?.startsWith('ace:') ? aceAt(kind.slice(4)) : null;

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

  const checkProblem = async (name, key, url, header, difficulty, expect, forbid) => {
    const snap = await waitFor(async () => {
      const value = await panelSnap();
      return value.includes(header) ? value : null;
    }, 30000);
    check(`${name}_header`, !!snap && (!difficulty || snap.includes(difficulty)), `${header}${difficulty ? ` / ${difficulty}` : ''}`);
    check(`${name}_no_timer_or_banner`, !!snap && !snap.includes('计时') && !snap.includes('作答不会被记录'));
    const conv = await waitFor(() => conversationFor(key), 30000);
    writeFileSync(path.join(ARTIFACTS, `platform-${name}-problem.txt`), conv?.problem ?? '');
    const missing = expect.filter((s) => !conv?.problem.includes(s));
    const leaked = forbid.filter((s) => conv?.problem.includes(s));
    check(`${name}_problem_message`, !!conv && !missing.length && !leaked.length, `missing=${JSON.stringify(missing)} leaked=${JSON.stringify(leaked)}`);
    if (url) check(`${name}_problem_url`, conv?.problemUrl === url, conv?.problemUrl);
  };

  for (const [index, c] of CASES.entries()) {
    if (index > 0) await openProblem(c.url);
    await checkProblem(c.name, c.key, c.url.replace(/#.*$/, ''), c.header, c.difficulty, c.expect, c.forbid);

    const editor = editorFor(c.editor);
    if (editor) {
      restoreCode.push({ url: c.url, editor, code: await ev(`() => ${editor.get}`, pageId) });
      const set = await ev(`() => ${editor.set(CODE)}`, pageId);
      if (!check(`${c.name}_editor_found`, set === true)) continue;
    }
    // 能标错误行的平台读代码再标第 2 行，只能读的读一次
    const steps = c.tools.includes('highlight_errors')
      ? [['get_code'], ['highlight_errors', { ranges: [{ startLine: 2, endLine: 2, message: '这里有问题' }] }]]
      : [['get_code']];
    const first = modelRequests;
    const [code, highlighted] = await ask('帮我看看第 2 行', steps);
    const offered = await ev(`() => (JSON.parse(window.__mockRequests[${first}].body ?? '{}').tools ?? []).map((t) => t.name)`, panelId);
    check(`${c.name}_tools_offered`, JSON.stringify(offered) === JSON.stringify(c.tools), JSON.stringify(offered));
    check(`${c.name}_get_code`, code?.code === CODE, JSON.stringify(code).slice(0, 120));
    if (c.tools.includes('highlight_errors')) {
      check(`${c.name}_highlight`, highlighted?.highlighted === 1, JSON.stringify(highlighted));
      const marks = await ev(`() => ${editor.marks}`, pageId);
      check(`${c.name}_highlight_shown`, marks?.lines?.[0] === 2 && marks.markers === editor.expectMarkers, JSON.stringify(marks));
      await ev(`() => ${editor.touch}`, pageId);
      const after = await ev(`() => ${editor.marks}`, pageId);
      check(`${c.name}_highlight_cleared_on_edit`, after?.lines?.length === 0, JSON.stringify(after));
    }
    if (editor) {
      const back = restoreCode.at(-1);
      if (back.code != null) await ev(`() => ${editor.set(back.code)}`, pageId);
      back.done = true;
    }
    if (c.then) {
      await mcp.call('navigate_page', { pageId, type: 'url', url: 'about:blank', timeout: 60000 }, 90000);
      await openProblem(c.then.from);
      const clicked = await ev(`() => { const a = document.querySelector('a[href="${c.then.link}"]'); a?.click(); return !!a; }`, pageId);
      if (check(`${c.name}_in_page_link`, clicked === true)) {
        await checkProblem(`${c.name}-spa`, c.then.key, null, c.then.header, null, c.then.expect, c.then.forbid);
      }
    }
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
      await ev(`() => ${item.editor.set(item.code)}`, pageId).catch(() => null);
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
