import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

// AI 工具 get_judge_result 的 e2e：在 two-sum 上真实「运行」，用模拟的模型让 AI 调用工具，检查工具读到的判题结果。
// 默认只运行、不提交；加 --submit 再真实提交一次错误代码（会记进 ACBuddy，检查完删掉这条作答）。
// 加 --site=leetcode.com 跑国际版。编辑器要是 C++。改过的编辑器代码、AI 配置和新建的对话结束时都会还原。
const EXT_NAME = 'ACBuddy';
const SITE = 'https://acbuddy.pages.dev';
const LEETCODE_SITE = process.argv.includes('--site=leetcode.com') ? 'leetcode.com' : 'leetcode.cn';
const SUBMIT = process.argv.includes('--submit');
const SETTINGS_KEY = 'acb-agent-settings';
const CATALOG_KEY = 'acb-agent-threads';
const MOCK_BASE = 'https://agent-e2e.invalid/v1';
const HEAD = 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n';
const WRONG = HEAD + '        cout << "n=" << nums.size() << endl;\n        for (int i = 0; i < nums.size(); i++)\n            for (int j = i; j < nums.size(); j++)\n                if (nums[i] + nums[j] == target) return {i, j};\n        return {};\n    }\n};';
const COMPILE = HEAD + '        int x = 1\n        return {};\n    }\n};';

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

// 侧边栏里拦下发往模拟地址的模型请求，记下请求体，由测试逐个放行并指定回复
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
const EDITOR_MODEL = `(window.monaco?.editor.getModels() ?? []).find((x) => x.getValue().includes('class Solution'))`;

const mcp = new McpClient();
const text = async (name, args, timeout = 60000) => mcp.text(await mcp.call(name, args, timeout));
let extId = null;
let pageId = null;
let panelId = null;
let original = null;
let originalCode = null;
let attemptsBefore = null;
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
const setCode = (code) =>
  ev(`() => { const m = ${EDITOR_MODEL}; if (!m) return null; m.setValue(${JSON.stringify(code)}); return m.getLanguageId(); }`, pageId);
const api = (method, p) =>
  ev(`async () => { const r = await fetch('${SITE}/api${p}', { method: '${method}', credentials: 'include' }); return { status: r.status, json: await r.json().catch(() => null) }; }`, panelId);

// 点「运行」或「提交」，等页面钩子整理好这次的判题结果
async function judge(button) {
  await ev('() => { delete window.__acbLastJudge; return true; }', pageId);
  const clicked = await ev(`() => { const b = document.querySelector('[data-e2e-locator="console-${button}-button"]'); if (!b) return false; b.click(); return true; }`, pageId);
  if (!clicked) throw new Error(`${button} button not found`);
  const kind = await waitFor(() => ev('() => window.__acbLastJudge?.kind ?? null', pageId), 90000);
  if (!kind) throw new Error(`${button}: no judge result in the page`);
  await sleep(1500);
}

let modelRequests = 0;
const release = async (reply) => {
  const n = ++modelRequests;
  const arrived = await waitFor(async () => (await ev('() => window.__mockRequests.length', panelId)) >= n, 20000);
  if (!arrived) throw new Error(`model request ${n} never arrived`);
  await ev(`() => window.__release(${JSON.stringify(reply)})`, panelId);
  return n;
};
// 下一次模型请求里带回的工具结果
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

  const np = await text('new_page', { url: `https://${LEETCODE_SITE}/problems/two-sum/`, timeout: 60000 }, 90000);
  pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await sleep(6000);
  for (let i = 0; i < 3; i++) {
    const s = await text('take_snapshot', { pageId });
    const skip = findUid(s, 'button "跳过"') ?? findUid(s, 'button "Skip"');
    if (!skip) break;
    await mcp.call('click', { pageId, uid: skip }, 60000);
    await sleep(1200);
  }
  originalCode = await ev(`() => ${EDITOR_MODEL}?.getValue() ?? null`, pageId);
  if (originalCode == null) throw new Error('editor not found');

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
  await waitFor(async () => /两数之和|Two Sum/.test(await panelSnap()), 30000);
  await ev(MOCK, panelId);
  const newChat = await waitFor(async () => findUid(await panelSnap(), 'button "新建对话"'), 15000);
  if (newChat) await mcp.call('click', { pageId: panelId, uid: newChat }, 60000);
  await sleep(800);

  const [none] = await ask('我刚才的运行结果怎么样', [['get_judge_result']]);
  check('no_result_before_judging', /还没有这道题的运行或提交结果/.test(none?.error ?? ''), JSON.stringify(none));
  check('panel_shows_tool_label', (await panelSnap()).includes('读取判题结果'));

  const lang = await setCode(WRONG);
  if (lang !== 'cpp') throw new Error(`two-sum editor is ${lang}; this test needs C++`);
  await judge('run');
  const [run, , highlighted] = await ask('为什么运行没通过', [
    ['get_judge_result'],
    ['get_code'],
    ['highlight_errors', { ranges: [{ startLine: 5, endLine: 5, message: '内层循环从 i 开始，会把同一个元素用两次' }] }],
  ]);
  writeFileSync(path.join(ARTIFACTS, 'judge-result-run.json'), JSON.stringify(run, null, 2));
  const second = run?.cases?.[1];
  check('run_status', run?.kind === 'run' && run?.status === 'Wrong Answer', `${run?.kind} ${run?.status}`);
  check('run_counts', run?.passed === 1 && run?.total === 3 && run?.cases?.length === 3, `${run?.passed}/${run?.total}, cases=${run?.cases?.length}`);
  check('run_failed_case', second?.input === '[3,2,4]\n6' && second?.expected === '[1,2]' && second?.output === '[0,0]' && second?.passed === false, JSON.stringify(second));
  check('run_stdout', second?.stdout === 'n=3\n', JSON.stringify(second?.stdout));
  check('run_code_unchanged', run?.codeChanged === false, String(run?.codeChanged));
  check('run_code_not_sent', run != null && !('code' in run));
  check('highlight_still_works', highlighted?.highlighted === 1, JSON.stringify(highlighted));

  await setCode(`${WRONG}\n// edited`);
  const [edited] = await ask('改完了，刚才的结果还对得上吗', [['get_judge_result']]);
  check('edit_marks_code_changed', edited?.codeChanged === true && edited?.status === 'Wrong Answer', String(edited?.codeChanged));

  await setCode(COMPILE);
  await judge('run');
  const [compile] = await ask('这个报错是什么意思', [['get_judge_result']]);
  check('compile_error', compile?.status === 'Compile Error' && /expected ';'/.test(compile?.errorMessage ?? ''), `${compile?.status}: ${compile?.errorMessage?.split('\n')[0]}`);

  if (SUBMIT) {
    const before = await api('GET', '/progress/leetcode/two-sum');
    attemptsBefore = Math.max(0, ...(before.json?.data?.attempts ?? []).map((a) => a.id));
    await setCode(WRONG);
    await judge('submit');
    const [submit] = await ask('提交为什么没通过', [['get_judge_result']]);
    writeFileSync(path.join(ARTIFACTS, 'judge-result-submit.json'), JSON.stringify(submit, null, 2));
    const failed = submit?.failedCase;
    check('submit_status', submit?.kind === 'submit' && submit?.status === 'Wrong Answer', `${submit?.kind} ${submit?.status} ${submit?.passed}/${submit?.total}`);
    check('submit_failed_case', failed?.input === '[3,2,4]\n6' && failed?.expected === '[1,2]' && failed?.output === '[0,0]', JSON.stringify(failed));
    const recorded = await waitFor(async () => {
      const r = await api('GET', '/progress/leetcode/two-sum');
      return (r.json?.data?.attempts ?? []).filter((a) => a.id > attemptsBefore);
    }, 15000).then((list) => list ?? []);
    check('submit_still_recorded', recorded.length === 1 && recorded[0].verdict === 'Wrong Answer' && recorded[0].language === 'cpp', JSON.stringify(recorded.map((a) => [a.id, a.verdict, a.language])));
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n== JUDGE RESULT E2E (${LEETCODE_SITE}${SUBMIT ? ', with submit' : ''}): ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ==`);
  if (failed.length) console.log(failed.map((f) => `${f.name}: ${f.detail}`).join('\n'));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  if (panelId != null) writeFileSync(path.join(ARTIFACTS, 'judge-result-panel-snapshot.txt'), await panelSnap().catch(() => ''));
  process.exitCode = 1;
} finally {
  try {
    if (pageId != null && originalCode != null) {
      await ev('() => { window.__acbAgentHighlights?.clear(); return true; }', pageId).catch(() => null);
      await setCode(originalCode).catch(() => null);
    }
    if (panelId != null && attemptsBefore != null) {
      const r = await api('GET', '/progress/leetcode/two-sum');
      for (const a of (r.json?.data?.attempts ?? []).filter((x) => x.id > attemptsBefore)) {
        console.log(`delete attempt ${a.id}:`, (await api('DELETE', `/attempts/${a.id}`)).status);
      }
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
          for (const [slug, id] of Object.entries(cat.selected)) {
            if (keep.has(id)) continue;
            const next = cat.conversations.find((c) => c.slug === slug);
            if (next) cat.selected[slug] = next.id;
            else delete cat.selected[slug];
          }
          await chrome.storage.local.set({ '${CATALOG_KEY}': cat });
          await chrome.storage.local.remove(removed.map((id) => 'acb-agent-thread:' + id));
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
