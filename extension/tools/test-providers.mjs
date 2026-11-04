import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

// 推荐模型的 e2e：设置里的服务预设和思考强度，以及 Claude 和 DeepSeek 两种接口在真实面板里的一次带工具调用的回答。
// 模型服务是模拟的（拦下面板发往官方地址的请求），工具在真实的力扣页面上执行；不保存设置、不提交，结束时还原。
const EXT_NAME = 'ACBuddy';
const SETTINGS_KEY = 'acb-agent-settings';
const CATALOG_KEY = 'acb-conversations';
const EXTRA_KEYS = ['acb-memory-enabled', 'acb-memory-notice-seen'];

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
const pageLines = (text) =>
  (text.match(/^\s*(\d+):\s*(.+)$/gm) ?? []).map((l) => {
    const m = l.match(/^\s*(\d+):\s*(.+)$/);
    return { id: Number(m[1]), desc: m[2] };
  });
const findUid = (snap, needle) =>
  (snap.split('\n').find((l) => l.includes(needle) && /uid=/.test(l))?.match(/\buid=([A-Za-z0-9_\-]+)/) ?? [])[1] ?? null;

// 面板里拦下发往四家官方地址的请求，按各家的格式回一段带工具调用的回答；记忆同步接口回空
const MOCK = `() => {
  const real = window.__acbRealFetch ?? window.fetch.bind(window);
  window.__acbRealFetch = real;
  window.__providerRequests = [];
  const encoder = new TextEncoder();
  const sse = (events, done) => new Response(new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\\n\\n'));
    if (done) controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const ANSWER = '第 6 行先存再查，同一个元素会被用两次。';
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes('/api/memories')) return json({ ok: true, data: (init.method ?? 'GET') === 'GET' ? { memories: [], more: false } : { updatedAt: Date.now() } });
    if (!['api.anthropic.com', 'api.deepseek.com', 'api.openai.com', 'openrouter.ai'].includes(url.hostname)) return real(input, init);
    const body = JSON.parse(init.body);
    window.__providerRequests.push({ host: url.hostname, path: url.pathname, headers: init.headers, body });
    if (!body.stream) {
      if (url.hostname === 'api.anthropic.com') return json({ content: [{ type: 'text', text: '{"memories":[]}' }], stop_reason: 'end_turn', usage: {} });
      return json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'm', type: 'function', function: { name: 'save_memories', arguments: '{"memories":[]}' } }] } }] });
    }
    if (url.hostname === 'api.anthropic.com') {
      const afterTool = body.messages.at(-1).content.some((block) => block.type === 'tool_result');
      const n = window.__providerRequests.length;
      return sse([
        { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: afterTool ? 2400 : 0, cache_creation_input_tokens: afterTool ? 300 : 2400, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-e2e-' + n } },
        { type: 'content_block_stop', index: 0 },
        ...(afterTool ? [
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ANSWER.slice(0, 6) } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ANSWER.slice(6) } },
          { type: 'content_block_stop', index: 1 },
        ] : [
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_e2e', name: 'get_code', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
          { type: 'content_block_stop', index: 1 },
        ]),
        { type: 'message_delta', delta: { stop_reason: afterTool ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 40 } },
        { type: 'message_stop' },
      ]);
    }
    const afterTool = body.messages.at(-1).role === 'tool';
    return sse([
      { choices: [{ delta: { role: 'assistant', reasoning_content: '先读代码' } }] },
      afterTool
        ? { choices: [{ delta: { content: ANSWER } }] }
        : { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e2e', type: 'function', function: { name: 'get_code', arguments: '{}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 2500, completion_tokens: 30, prompt_cache_hit_tokens: afterTool ? 2300 : 0, prompt_tokens_details: { cached_tokens: afterTool ? 2300 : 0 } } },
    ], true);
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
const choose = async (needle, value) => {
  const uid = await waitFor(async () => findUid(await panelSnap(), needle), 10000);
  if (!uid) throw new Error(`没有找到：${needle}`);
  await mcp.call('fill', { pageId: panelId, uid, value }, 60000);
  await sleep(400);
};
async function ask(question) {
  const input = await waitFor(async () => findUid(await panelSnap(), 'textbox "向 AI 提问"'), 30000);
  if (!input) throw new Error('chat input not found');
  await mcp.call('click', { pageId: panelId, uid: input }, 60000);
  await mcp.call('fill', { pageId: panelId, uid: input, value: question }, 60000);
  const ready = await waitFor(async () => (await panelSnap()).split('\n').some((l) => l.includes('button "发送"') && !l.includes('disabled')), 30000);
  if (!ready) throw new Error('send button stayed disabled');
  await mcp.call('press_key', { pageId: panelId, key: 'Enter' }, 60000);
}
const requests = async () => {
  const raw = await ev('() => JSON.stringify(window.__providerRequests ?? [])', panelId);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};
const useSettings = async (settings) => {
  await ev(`async () => {
    await chrome.storage.local.set({ '${SETTINGS_KEY}': ${JSON.stringify(settings)}, 'acb-memory-enabled': false, 'acb-memory-notice-seen': true });
    setTimeout(() => location.reload(), 50);
    return true;
  }`, panelId).catch(() => null);
  await sleep(3500);
  panelId = (await findPanel()) ?? panelId;
  await waitFor(async () => /两数之和|Two Sum/.test(await panelSnap()), 30000);
  await ev(MOCK, panelId);
};

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
    const keys = ['${SETTINGS_KEY}', '${CATALOG_KEY}', ...${JSON.stringify(EXTRA_KEYS)}];
    const d = await chrome.storage.local.get(keys);
    return { stored: Object.fromEntries(keys.filter((key) => key !== '${CATALOG_KEY}' && key in d).map((key) => [key, d[key]])), ids: (d['${CATALOG_KEY}']?.conversations ?? []).map((c) => c.id) };
  }`, panelId);

  // 地址、密钥和模型都自己填；是哪家服务、用哪种接口按地址判断（测试用的密钥都是假的）
  await ev(`async () => {
    await chrome.storage.local.remove('${SETTINGS_KEY}');
    await chrome.storage.local.set({ 'acb-memory-enabled': false, 'acb-memory-notice-seen': true });
    setTimeout(() => location.reload(), 50);
    return true;
  }`, panelId).catch(() => null);
  await sleep(3500);
  panelId = (await findPanel()) ?? panelId;
  await waitFor(async () => /两数之和|Two Sum/.test(await panelSnap()), 30000);
  await click('button "设置"');
  const field = (name) => new RegExp(`(?:textbox|combobox) "${name}"`);
  let snap = await waitFor(async () => { const s = await panelSnap(); return field('API 地址').test(s) ? s : null; }, 10000) ?? '';
  check('settings_three_fields', field('API 地址').test(snap) && field('API Key').test(snap) && field('模型').test(snap) && !snap.includes('思考强度') && !snap.includes('接口类型') && !snap.includes('combobox "服务"'));
  const fill = async (name, value) => {
    const uid = await waitFor(async () => { const line = (await panelSnap()).split('\n').find((l) => field(name).test(l)); return line?.match(/\buid=([A-Za-z0-9_\-]+)/)?.[1] ?? null; }, 10000);
    await mcp.call('fill', { pageId: panelId, uid, value }, 60000);
    await sleep(400);
    return panelSnap();
  };
  const modelHints = async () => String(await ev(`() => JSON.stringify({ placeholder: document.querySelector('input[list="acb-model-presets"]')?.placeholder ?? null,
    presets: [...document.querySelectorAll('#acb-model-presets option')].map((option) => option.value) })`, panelId));
  const urls = String(await ev(`() => JSON.stringify([...document.querySelectorAll('#acb-url-presets option')].map((option) => option.value))`, panelId));
  check('url_suggestions', ['https://api.deepseek.com', 'https://api.openai.com/v1', 'https://api.anthropic.com/v1', 'https://openrouter.ai/api/v1'].every((url) => urls.includes(url)), urls);
  snap = await fill('API 地址', 'https://api.deepseek.com');
  let hints = await modelHints();
  check('known_url_effort_and_models', /combobox "思考强度"[^\n]*value="默认"/.test(snap) && hints.includes('例如 deepseek-flash') && hints.includes('"presets":["deepseek-flash"]'), hints);
  check('known_url_no_interface_note', !snap.includes('接口调用'));
  snap = await fill('API 地址', 'https://openrouter.ai/api/v1');
  hints = await modelHints();
  check('openrouter_models', ['deepseek/deepseek-v4.1-flash', 'openai/gpt-5.6-luna', 'openai/gpt-5.6-terra', 'anthropic/claude-sonnet-5.5'].every((id) => hints.includes(id)), hints);
  snap = await fill('模型', 'qwen/qwen3-coder');
  check('model_typed_freely', new RegExp(`${field('模型').source}[^\\n]*value="qwen/qwen3-coder"`).test(snap));
  snap = await fill('API 地址', 'https://relay.example.com/v1');
  check('unknown_url_chat', snap.includes('按 Chat Completions 接口调用') && !snap.includes('思考强度'));
  snap = await fill('API 地址', 'https://relay.example.com/v1/responses');
  check('unknown_url_responses', snap.includes('按 Responses 接口调用'));
  await text('take_screenshot', { pageId: panelId, filePath: path.join(ARTIFACTS, 'providers-settings.png') }).catch(() => null);
  await click('button "关闭"').catch(() => null);
  // Claude：带签名的思考块原样发回、缓存标记、官方接口的请求头，工具在真实页面上读代码
  await useSettings({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', apiKey: 'e2e-key', effort: 'high' });
  await click('button "新建对话"');
  await sleep(1000);
  await ask('帮我看看代码哪里错了');
  let answered = await waitFor(async () => (await panelSnap()).includes('同一个元素会被用两次'), 30000);
  check('claude_answer_shown', !!answered);
  let sent = (await requests()).filter((item) => item.host === 'api.anthropic.com' && item.body.stream);
  const [first, second] = sent;
  check('claude_two_requests', sent.length === 2, `${sent.length} 次`);
  check('claude_headers', first?.headers['x-api-key'] === 'e2e-key' && first?.headers['anthropic-version'] === '2026-10-21' &&
    first?.headers['anthropic-dangerous-direct-browser-access'] === 'true' && /thinking-binding-controls/.test(first?.headers['anthropic-beta'] ?? ''), JSON.stringify(first?.headers ?? {}).replace('e2e-key', '***'));
  check('claude_path', first?.path === '/v1/messages');
  check('claude_thinking_effort_fallback', first?.body.thinking?.type === 'adaptive' && first?.body.output_config?.effort === 'high' && first?.body.fallbacks === 'default', `effort ${first?.body.output_config?.effort}`);
  check('claude_problem_cached', first?.body.messages[0]?.content[0]?.cache_control?.ttl === '1h' && /两数之和/.test(first?.body.messages[0]?.content[0]?.text ?? ''));
  const replayed = second?.body.messages[1]?.content ?? [];
  check('claude_thinking_replayed', replayed[0]?.type === 'thinking' && replayed[0]?.signature === 'sig-e2e-1' && replayed[1]?.type === 'tool_use');
  const result = second?.body.messages[2]?.content?.[0];
  check('claude_tool_result_from_page', result?.type === 'tool_result' && result?.tool_use_id === 'toolu_e2e' && /twoSum|class Solution|def /.test(result?.content ?? ''), String(result?.content ?? '').slice(0, 80));
  await click('button "运行详情"').catch(() => null);
  snap = await panelSnap();
  check('claude_trace_cache_write', /写入缓存 2700/.test(snap) && /缓存命中 2400/.test(snap), (snap.match(/输入 [^\n"]*/) ?? [''])[0]);
  check('claude_trace_effort', snap.includes('思考强度：高'));

  // DeepSeek：推理文字每次都发回去
  await useSettings({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'e2e-key', effort: 'low' });
  await click('button "新建对话"');
  await sleep(1000);
  await ask('帮我看看代码哪里错了');
  answered = await waitFor(async () => (await panelSnap()).includes('同一个元素会被用两次'), 30000);
  check('deepseek_answer_shown', !!answered);
  sent = (await requests()).filter((item) => item.host === 'api.deepseek.com' && item.body.stream);
  check('deepseek_path_and_key', sent[0]?.path === '/chat/completions' && sent[0]?.headers.Authorization === 'Bearer e2e-key');
  check('deepseek_effort', sent.every((item) => item.body.reasoning_effort === 'low'), sent.map((item) => item.body.reasoning_effort).join(','));
  const assistant = sent[1]?.body.messages.find((message) => message.role === 'assistant');
  check('deepseek_reasoning_passed_back', assistant?.reasoning_content === '先读代码' && assistant?.tool_calls?.[0]?.id === 'call_e2e');

  const errors = await text('list_console_messages', { pageId: panelId, types: ['error'] }).catch(() => '');
  check('console_panel_clean', !/\berror\b/i.test(errors.replace(/no console messages/i, '')), errors.includes('<no console messages') || !errors.trim() ? 'no errors' : errors.slice(0, 200));
  writeFileSync(path.join(ARTIFACTS, 'providers-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((item) => !item.pass);
  console.log(failed.length ? `\n== PROVIDERS E2E: ${failed.length} FAILED ==` : '\n== PROVIDERS E2E: ALL PASS ==');
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error('FATAL', error.message);
  process.exitCode = 1;
} finally {
  try {
    if (panelId != null && original) {
      const removed = await ev(`async () => {
        if (window.__acbRealFetch) window.fetch = window.__acbRealFetch;
        const stored = ${JSON.stringify(original.stored)};
        await chrome.storage.local.remove(['${SETTINGS_KEY}', ...${JSON.stringify(EXTRA_KEYS)}].filter((key) => !(key in stored)));
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
      }`, panelId);
      console.log(`cleanup: ${removed} conversation(s) removed, AI settings restored`);
    }
    await sleep(1500);
  } catch (error) {
    console.error('cleanup failed:', error.message);
    process.exitCode = 1;
  }
  await mcp.stop();
}
