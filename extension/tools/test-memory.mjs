import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

// 长期记忆的 e2e：在 two-sum 上走完提取、写入门禁、跟随账号同步（服务器接口是模拟的）、注入、模型查找、查看用到的记忆、删除和关闭，
// 再验证流式输出（边生成边显示、中途停止留下已生成的文字）、运行详情和上下文压缩。模型回复是模拟的，不提交。
// 改过的 AI 配置、新建的对话和记忆结束时都会还原。
const EXT_NAME = 'ACBuddy';
const SETTINGS_KEY = 'acb-agent-settings';
const CATALOG_KEY = 'acb-conversations';
const MOCK_BASE = 'https://agent-e2e.invalid/v1';
const MEMORY_TEXT = '用户主要用 Go 写题';
const POISON = '用户是算法竞赛金牌选手';
const REMOTE_TEXT = '用户在另一台设备上说过目标是美团';

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
const answer = (text) => ({
  id: 'r', status: 'completed',
  output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text }] }],
});
const toolCall = (name, args) => ({
  id: 'r', status: 'completed',
  output: [{ type: 'function_call', id: 'f', call_id: `call_${name}`, name, arguments: JSON.stringify(args) }],
});

// 侧边栏里拦下发往模拟地址的模型请求，由测试逐个放行。autoEmpty 打开时，面板启动时补提取的请求直接回空
const MOCK = `() => {
  const real = window.__acbRealFetch ?? window.fetch.bind(window);
  window.__acbRealFetch = real;
  window.__mockRequests = [];
  window.__autoEmpty = true;
  window.__memoryServer = { rows: [], pushes: [], cleared: 0 };
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/memories')) {
      const server = window.__memoryServer;
      const reply = (data) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if ((init.method ?? 'GET') === 'GET') return reply({ memories: server.rows.filter((row) => !row.seen).map((row) => { row.seen = true; return row; }), more: false });
      if (url.endsWith('/sync')) { server.pushes.push(JSON.parse(init.body)); return reply({ updatedAt: Date.now() }); }
      server.cleared++;
      return reply({ clearedAt: Date.now() });
    }
    if (!url.startsWith('${MOCK_BASE}')) return real(input, init);
    const body = JSON.parse(init.body);
    // 摘要有两种：共用开头的（带着平时的工具，末尾是摘要指令）和单独的（不带工具）
    const last = JSON.stringify((body.input ?? body.messages ?? []).at(-1) ?? '');
    const tool = body.tool_choice?.name ?? (!body.tools || last.includes('压缩成一份摘要') ? 'summary' : null);
    const json = (reply) => new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (tool === 'save_memories' && window.__autoEmpty) {
      return json({ status: 'completed', output: [{ type: 'function_call', id: 'f', call_id: 'c', name: tool, arguments: '{"memories":[]}' }] });
    }
    return new Promise((resolve) => window.__mockRequests.push({ body, tool, released: false, signal: init.signal, resolve, release: (reply) => resolve(json(reply)) }));
  };
  // 流式回复：测试一段段推送，最后用 __streamEnd 结束
  window.__streamStart = (tool) => {
    const entry = window.__mockRequests.find((item) => !item.released && item.tool === tool);
    if (!entry) return false;
    entry.released = true;
    const stream = new TransformStream();
    window.__writer = stream.writable.getWriter();
    // 真实的 fetch 中止时响应流会报错，模拟的也要这样
    entry.signal?.addEventListener('abort', () => window.__writer.abort(entry.signal.reason));
    entry.release = null;
    entry.resolve(new Response(stream.readable, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    return true;
  };
  window.__streamPush = (event) => window.__writer.write(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\\n\\n')).then(() => true);
  window.__streamEnd = () => window.__writer.close().then(() => true);
  window.__next = (tool) => {
    const entry = window.__mockRequests.find((item) => !item.released && item.tool === tool);
    return entry ? JSON.stringify(entry.body) : null;
  };
  window.__release = (tool, reply) => {
    const entry = window.__mockRequests.find((item) => !item.released && item.tool === tool);
    if (!entry) return false;
    entry.released = true;
    entry.release(reply);
    return true;
  };
  return 'mocked';
}`;

const mcp = new McpClient();
const text = async (name, args, timeout = 60000) => mcp.text(await mcp.call(name, args, timeout));
let extId = null;
let pageId = null;
let panelId = null;
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
const panelSnap = () => text('take_snapshot', { pageId: panelId });
const findPanel = async () =>
  pageLines(await text('list_pages', {})).find((p) => p.desc.includes(`chrome-extension://${extId}`) && p.desc.includes('sidepanel'))?.id ?? null;
const click = async (needle, timeout = 15000) => {
  const uid = await waitFor(async () => findUid(await panelSnap(), needle), timeout);
  if (!uid) throw new Error(`没有找到：${needle}`);
  await mcp.call('click', { pageId: panelId, uid }, 60000);
};
const nextRequest = async (tool, timeout = 20000) => {
  const raw = await waitFor(() => ev(`() => window.__next(${JSON.stringify(tool)})`, panelId), timeout);
  if (!raw) throw new Error(`模型请求没有发出：${tool ?? '回答'}`);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};
const release = (tool, reply) => ev(`() => window.__release(${JSON.stringify(tool)}, ${JSON.stringify(reply)})`, panelId);
const finished = () => waitFor(async () => !(await panelSnap()).includes('button "停止回答"'), 20000);
async function ask(question) {
  const input = await waitFor(async () => findUid(await panelSnap(), 'textbox "向 AI 提问"'), 30000);
  if (!input) throw new Error('chat input not found');
  await mcp.call('click', { pageId: panelId, uid: input }, 60000);
  await mcp.call('fill', { pageId: panelId, uid: input, value: question }, 60000);
  const ready = await waitFor(async () => (await panelSnap()).split('\n').some((l) => l.includes('button "发送"') && !l.includes('disabled')), 30000);
  if (!ready) throw new Error('send button stayed disabled');
  await mcp.call('press_key', { pageId: panelId, key: 'Enter' }, 60000);
}
const latestUser = (body) => body.input.filter((item) => item.role === 'user').at(-1)?.content ?? '';
// 只清已经存在的库：open 一个不存在的库会建出没有表的空库，插件自己的建表就不会再跑了
const clearMemoryDb = () => `async () => {
  if (!(await indexedDB.databases()).some((item) => item.name === 'acbuddy-memory')) return true;
  return new Promise((resolve) => {
    const request = indexedDB.open('acbuddy-memory');
    request.onsuccess = () => {
      const db = request.result;
      const stores = ['memories', 'progress', 'outbox', 'sync'].filter((name) => db.objectStoreNames.contains(name));
      if (!stores.length) {
        db.close();
        indexedDB.deleteDatabase('acbuddy-memory').onsuccess = () => resolve(true);
        return;
      }
      const transaction = db.transaction(stores, 'readwrite');
      for (const name of stores) transaction.objectStore(name).clear();
      transaction.oncomplete = () => { db.close(); resolve(true); };
    };
    request.onerror = () => resolve(false);
  });
}`;

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
  const np = await text('new_page', { url: 'https://leetcode.cn/problems/two-sum/', timeout: 60000 }, 90000);
  pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await sleep(6000);
  for (let i = 0; i < 3 && panelId == null; i++) {
    await mcp.call('trigger_extension_action', { id: extId }, 60000);
    await waitFor(async () => (panelId = await findPanel()), 8000);
  }
  if (!check('side_panel_opened', panelId != null)) throw new Error('side panel not found');
  original = await ev(`async () => {
    const d = await chrome.storage.local.get(['${SETTINGS_KEY}', '${CATALOG_KEY}', 'acb-memory-enabled', 'acb-memory-notice-seen']);
    return { hasSettings: '${SETTINGS_KEY}' in d, settings: d['${SETTINGS_KEY}'] ?? null, ids: (d['${CATALOG_KEY}']?.conversations ?? []).map((c) => c.id) };
  }`, panelId);
  await ev(clearMemoryDb(), panelId);
  await ev(`async () => {
    await chrome.storage.local.remove(['acb-memory-enabled', 'acb-memory-notice-seen']);
    await chrome.storage.local.set({ '${SETTINGS_KEY}': { baseUrl: '${MOCK_BASE}/responses', model: 'e2e-model', apiKey: 'e2e-key' } });
    setTimeout(() => location.reload(), 50);
    return true;
  }`, panelId).catch(() => null);
  await sleep(3500);
  panelId = (await findPanel()) ?? panelId;
  await waitFor(async () => /两数之和|Two Sum/.test(await panelSnap()), 30000);
  await ev(MOCK, panelId);
  check('first_run_notice', (await panelSnap()).includes('已开启长期记忆'));
  await click('button "知道了"');
  await click('button "新建对话"');
  await sleep(1000);
  await ev('() => { window.__autoEmpty = false; return true; }', panelId);

  // 第一次提问：还没有记忆
  await ask('我以后都用 Go 写题');
  let body = await nextRequest(null);
  check('tags_in_problem_message', /标签：[^\n]*数组/.test(JSON.stringify(body.input[0].content ?? '').replaceAll('\\n', '\n')), String(body.input[0].content ?? '').split('\n').find((l) => l.startsWith('标签')) ?? '无标签');
  check('no_memory_block_when_empty', !latestUser(body).includes('<memory>'));
  await release(null, answer('好的'));
  await finished();

  // 切到新对话时提取上一段
  await click('button "新建对话"');
  body = await nextRequest('save_memories');
  const transcript = JSON.stringify(body.input);
  check('extraction_forces_tool', body.tool_choice?.type === 'function' && body.tool_choice?.name === 'save_memories');
  check('extraction_has_user_text', transcript.includes('我以后都用 Go 写题'));
  check('extraction_hides_statement', !transcript.includes('整数数组') && !transcript.includes('nums'), '题面没有发给提取模型');
  const memory = (memoryText, quote) => ({ type: 'semantic', text: memoryText, quote, concepts: [], importance: 5, scope: 'persistent', problem_specific: false });
  await release('save_memories', { status: 'completed', output: [{ type: 'function_call', id: 'f', call_id: 'c', name: 'save_memories', arguments: JSON.stringify({ memories: [memory(MEMORY_TEXT, '我以后都用 Go 写题'), memory(POISON, '整数数组')] }) }] });
  await sleep(1500);

  await click('button "记忆"');
  let snap = await waitFor(async () => { const s = await panelSnap(); return s.includes(MEMORY_TEXT) ? s : null; }, 10000);
  check('memory_saved_and_listed', !!snap);
  check('poison_blocked_by_gate', !!snap && !snap.includes(POISON));

  // 跟随账号同步：记忆传上去，原话不传；别的设备写的记忆拉下来
  const uploaded = await waitFor(async () => {
    const pushes = await ev('() => JSON.stringify(window.__memoryServer.pushes)', panelId);
    const text = typeof pushes === 'string' ? pushes : JSON.stringify(pushes);
    return text.includes(MEMORY_TEXT) ? text : null;
  }, 10000);
  check('memory_uploaded', !!uploaded);
  check('upload_has_no_quote_or_conversation', !!uploaded && !uploaded.includes('我以后都用 Go 写题') && !uploaded.includes('quote') && !uploaded.includes('evidence') && !uploaded.includes(POISON));
  await click('button "关闭"');
  await ev(`() => {
    window.__memoryServer.rows.push({ id: 'other-device', type: 'semantic', text: '${REMOTE_TEXT}', concepts: [], problemKey: null, importance: 1, attemptIds: [], sources: [], validFrom: Date.now() - 1000, invalidAt: null, createdAt: Date.now() - 1000, supersededBy: null, updatedAt: Date.now(), deleted: false });
    return true;
  }`, panelId);
  await click('button "记忆"');
  snap = await waitFor(async () => { const s = await panelSnap(); return s.includes(REMOTE_TEXT) ? s : null; }, 10000);
  check('memory_from_other_device_pulled', !!snap);
  await click('button "关闭"');
  await sleep(500);

  // 第二次提问：带上记忆，模型还能主动查
  await ask('这题怎么下手');
  body = await nextRequest(null);
  check('memory_injected_before_question', latestUser(body).includes('<memory>') && latestUser(body).includes(MEMORY_TEXT) && latestUser(body).endsWith('这题怎么下手'));
  check('memory_not_in_system_prompt', !String(body.instructions).includes(MEMORY_TEXT));
  check('search_tool_offered', body.tools.some((tool) => tool.name === 'search_memory'));
  await release(null, toolCall('search_memory', { query: 'Go 写题' }));
  body = await nextRequest(null);
  const output = body.input.find((item) => item.type === 'function_call_output')?.output ?? '';
  check('search_returns_memory', output.includes(MEMORY_TEXT), output.slice(0, 120));
  await release(null, answer('先想想哈希表'));
  await finished();
  const stored = await ev(`async () => {
    const cat = (await chrome.storage.local.get('${CATALOG_KEY}'))['${CATALOG_KEY}'];
    const key = 'acb-conversation:' + cat.selected['leetcode:two-sum'];
    const rec = (await chrome.storage.local.get(key))[key];
    return rec.messages.filter((m) => m.role === 'user' && m.kind !== 'problem').map((m) => m.content);
  }`, panelId);
  check('memory_not_saved_into_conversation', Array.isArray(stored) && stored.at(-1) === '这题怎么下手', JSON.stringify(stored));

  // 看这条回答用到了哪些记忆
  await click('button "这条回答用到的记忆（');
  snap = await waitFor(async () => { const s = await panelSnap(); return s.includes(MEMORY_TEXT) ? s : null; }, 8000);
  check('used_memories_shown', !!snap);

  // 记忆跟着提问留在历史里，下一次提问原样重发，不再重复注入
  await ask('还有别的思路吗');
  body = await nextRequest(null);
  const users = body.input.filter((item) => item.role === 'user').map((item) => item.content);
  const earlier = users.find((content) => content.endsWith('这题怎么下手')) ?? '';
  check('memory_kept_in_history', earlier.includes('<memory>') && earlier.includes(MEMORY_TEXT));
  check('memory_not_repeated', !latestUser(body).includes('<memory>') && latestUser(body).endsWith('还有别的思路吗'));
  await release(null, answer('也可以排序加双指针'));
  await finished();

  // 删除后不再注入
  await click('button "记忆"');
  await click(`button "删除记忆：${MEMORY_TEXT}"`);
  await click(`button "确认删除记忆：${MEMORY_TEXT}"`);
  snap = await waitFor(async () => { const s = await panelSnap(); return !s.includes(MEMORY_TEXT) ? s : null; }, 8000);
  check('memory_deleted', !!snap);
  const removed = await waitFor(async () => {
    const pushes = await ev('() => JSON.stringify(window.__memoryServer.pushes.flatMap((item) => item.remove))', panelId);
    const list = typeof pushes === 'string' ? JSON.parse(pushes) : pushes;
    return list.length ? list : null;
  }, 10000);
  check('deletion_uploaded', !!removed && removed.length === 1, JSON.stringify(removed));
  await click(`button "删除记忆：${REMOTE_TEXT}"`);
  await click(`button "确认删除记忆：${REMOTE_TEXT}"`);
  await waitFor(async () => (await panelSnap()).includes('还没有记忆'), 8000);
  await click('button "关闭"');
  await sleep(500);
  await ask('再问一次');
  body = await nextRequest(null);
  // 同一段对话的历史里还留着上一轮 search_memory 的结果，这里只看这一轮注入的内容
  check('deleted_memory_not_injected', !latestUser(body).includes(MEMORY_TEXT));
  check('deleted_memory_removed_from_history', body.input.filter((item) => item.role === 'user').every((item) => !String(item.content).includes(MEMORY_TEXT)));
  await release(null, answer('好'));
  await finished();

  // 关闭后不注入、不提供查找工具，也不提取
  await click('button "记忆"');
  await click('checkbox "记住我的目标、偏好和薄弱点"');
  await click('button "关闭"');
  await sleep(500);
  await ask('关闭后再问');
  body = await nextRequest(null);
  check('disabled_no_memory_tool', !body.tools.some((tool) => tool.name === 'search_memory') && !latestUser(body).includes('<memory>'));
  await release(null, answer('好'));
  await finished();
  await click('button "新建对话"');
  await sleep(2500);
  check('disabled_no_extraction', !(await ev(`() => window.__next('save_memories')`, panelId)));

  // 流式：边生成边显示，运行详情里有用量
  await ask('流式回答');
  await nextRequest(null);
  await ev('() => window.__streamStart(null)', panelId);
  await ev(`() => window.__streamPush({ type: 'response.output_text.delta', delta: '先想想' })`, panelId);
  snap = await waitFor(async () => { const s = await panelSnap(); return s.includes('先想想') && s.includes('button "停止回答"') ? s : null; }, 8000);
  check('stream_shows_partial_text', !!snap);
  await ev(`() => window.__streamPush({ type: 'response.output_text.delta', delta: '哈希表怎么用' })`, panelId);
  snap = await waitFor(async () => { const s = await panelSnap(); return s.includes('先想想哈希表怎么用') ? s : null; }, 8000);
  check('stream_appends_text', !!snap);
  await ev(`() => window.__streamPush({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100 } }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先想想哈希表怎么用' }] }] } })`, panelId);
  await ev('() => window.__streamEnd()', panelId);
  await finished();
  await click('button "运行详情"');
  snap = await waitFor(async () => { const s = await panelSnap(); return s.includes('输入 120 token') ? s : null; }, 8000);
  check('trace_shows_usage', !!snap && snap.includes('缓存命中 100') && snap.includes('输出 30 token'));

  // 中途停止：已经生成的文字留下来
  await ask('中途停止');
  await nextRequest(null);
  await ev('() => window.__streamStart(null)', panelId);
  await ev(`() => window.__streamPush({ type: 'response.output_text.delta', delta: '生成到一半' })`, panelId);
  await waitFor(async () => (await panelSnap()).includes('生成到一半'), 8000);
  await click('button "停止回答"');
  await finished();
  snap = await panelSnap();
  check('stop_keeps_partial_text', snap.includes('生成到一半') && snap.includes('本次回答已停止'));

  // 上下文压缩：对话很长时先摘要，发给模型的是摘要加最近的消息，完整记录还在
  const conversationId = await ev(`async () => (await chrome.storage.local.get('${CATALOG_KEY}'))['${CATALOG_KEY}'].selected['leetcode:two-sum']`, panelId);
  await ev(`async () => {
    const key = 'acb-conversation:${conversationId}';
    const record = (await chrome.storage.local.get(key))[key];
    for (let i = 0; i < 12; i++) record.messages.push({ role: 'user', content: '很早的提问' + i + '字'.repeat(6000) }, { role: 'assistant', content: '很早的回答' + i });
    await chrome.storage.local.set({ [key]: record });
    setTimeout(() => location.reload(), 50);
    return true;
  }`, panelId).catch(() => null);
  await sleep(3500);
  panelId = (await findPanel()) ?? panelId;
  await waitFor(async () => (await panelSnap()).includes('很早的回答11'), 30000);
  await ev(MOCK, panelId);
  await ev('() => { window.__autoEmpty = false; return true; }', panelId);
  await ask('压缩之后的问题');
  body = await nextRequest('summary');
  const summaryInput = JSON.stringify(body.input);
  // 共用开头：同样的系统提示和工具，历史原样带上，只在末尾加摘要指令
  check('summary_shares_the_prefix', Array.isArray(body.tools) && body.tools.length > 0 && summaryInput.includes('很早的提问0') && summaryInput.includes('压缩之后的问题') && JSON.stringify(body.input.at(-1)).includes('压缩成一份摘要'));
  await release('summary', answer('这是摘要内容'));
  body = await nextRequest(null);
  const sent = JSON.stringify(body.input);
  check('summary_replaces_old_turns', sent.includes('这是摘要内容') && !sent.includes('很早的提问0') && sent.includes('压缩之后的问题'));
  check('problem_kept_after_summary', sent.includes('当前题目信息'));
  await release(null, answer('压缩后的回答'));
  await finished();
  snap = await panelSnap();
  check('full_history_still_shown', snap.includes('很早的回答11') && snap.includes('压缩后的回答') && !snap.includes('这是摘要内容'));

  let conText = '';
  try { conText = await text('list_console_messages', { pageId: panelId }); } catch {}
  // 模拟安装之前，面板启动时的提取和同步会真的发出去：模拟的模型地址连不上，线上还没部署记忆接口时是 404
  const errors = conText.split('\n').filter((l) => /\[error\]/i.test(l)).filter((l) => !/Chrome DevTools MCP|status of 404|ERR_CONNECTION_CLOSED|ERR_NAME_NOT_RESOLVED/i.test(l));
  check('console_panel_clean', errors.length === 0, errors.join(' | ') || 'no errors');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n== MEMORY E2E: ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ==`);
  if (failed.length) console.log(failed.map((f) => `${f.name}: ${f.detail}`).join('\n'));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  if (panelId != null) {
    writeFileSync(path.join(ARTIFACTS, 'memory-panel-snapshot.txt'), await panelSnap().catch(() => ''));
    console.error(await text('list_console_messages', { pageId: panelId }).catch(() => ''));
    console.error(await ev('() => JSON.stringify(window.__mockRequests?.map((item) => [item.tool, item.released]))', panelId).catch(() => ''));
  }
  process.exitCode = 1;
} finally {
  try {
    if (panelId != null && original) {
      const restore = original.hasSettings
        ? `chrome.storage.local.set({ '${SETTINGS_KEY}': ${JSON.stringify(original.settings)} })`
        : `chrome.storage.local.remove('${SETTINGS_KEY}')`;
      await ev(clearMemoryDb(), panelId).catch(() => null);
      const removed = await ev(`async () => {
        if (window.__acbRealFetch) window.fetch = window.__acbRealFetch;
        await ${restore};
        await chrome.storage.local.remove(['acb-memory-enabled', 'acb-memory-notice-seen']);
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
      console.log(`cleanup: ${removed} conversation(s) removed, AI settings and memories restored`);
    }
    await sleep(1500);
  } catch (error) {
    console.error('cleanup failed:', error.message);
    process.exitCode = 1;
  }
  await mcp.stop();
}
