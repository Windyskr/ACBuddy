import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

const EXT_NAME = 'ACBuddy';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(ARTIFACTS, { recursive: true });

const CASES = [
  {
    name: '题目页（根路径）',
    url: 'https://leetcode.cn/problems/two-sum/',
    slug: 'two-sum',
    strict: true,
    titleIncludes: '两数之和',
    difficulty: '简单',
  },
  {
    name: '题目页 description 子路径',
    url: 'https://leetcode.cn/problems/longest-substring-without-repeating-characters/description/',
    slug: 'longest-substring-without-repeating-characters',
    strict: true,
    titleIncludes: '无重复字符的最长子串',
    difficulty: '中等',
  },
  {
    name: '题解列表页 /solutions/',
    url: 'https://leetcode.cn/problems/number-of-islands/solutions/',
    slug: 'number-of-islands',
    strict: false,
    titleIncludes: '岛屿数量',
  },
  {
    name: '提交记录页 /submissions/（未登录可能为空列表）',
    url: 'https://leetcode.cn/problems/merge-two-sorted-lists/submissions/',
    slug: 'merge-two-sorted-lists',
    strict: false,
    titleIncludes: '合并两个有序链表',
  },
  {
    name: '官方题解页 /editorial/',
    url: 'https://leetcode.cn/problems/two-sum/editorial/',
    slug: 'two-sum',
    strict: false,
    titleIncludes: '两数之和',
  },
];

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return pass;
};
const unwrap = (s) => {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = m ? m[1].trim() : s.trim();
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};
const pageLines = (text) =>
  (text.match(/^\s*(\d+):\s*(.+)$/gm) ?? []).map((l) => {
    const m = l.match(/^\s*(\d+):\s*(.+)$/);
    return { id: Number(m[1]), desc: m[2].replace(/\s*\[selected\]\s*$/, '') };
  });

const mcp = new McpClient();

async function getSwId() {
  const lp = mcp.text(await mcp.call('list_pages', {}));
  const m = lp.match(/(sw-\d+):\s*chrome-extension:\/\/[a-p0-9]+\//);
  return m?.[1] ?? null;
}

async function sendToActiveTab(msg) {
  const swId = await getSwId();
  if (!swId) throw new Error('service worker not visible in list_pages');
  await mcp.call(
    'evaluate_script',
    {
      serviceWorkerId: swId,
      function: `async () => {
        self.__wxtMsg = { done: false };
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab?.id) {
            self.__wxtMsg = { done: true, value: { ok: false, error: 'no active tab' } };
            return 'sent';
          }
          chrome.tabs.sendMessage(tab.id, ${JSON.stringify(msg)}, (res) => {
            const err = chrome.runtime.lastError;
            self.__wxtMsg = { done: true, value: err ? { ok: false, error: err.message } : res };
          });
          return 'sent';
        } catch (e) {
          self.__wxtMsg = { done: true, value: { ok: false, error: String(e) } };
          return 'sent';
        }
      }`,
    },
    60000,
  );
  for (let i = 0; i < 25; i++) {
    const t = unwrap(
      mcp.text(
        await mcp.call(
          'evaluate_script',
          { serviceWorkerId: swId, function: '() => self.__wxtMsg ?? { done: false }' },
          60000,
        ),
      ),
    );
    if (t?.done) return t.value;
    await sleep(300);
  }
  throw new Error('content script did not respond in time');
}

try {
  await mcp.start();

  const findExtId = async () => {
    const r = await mcp.call('list_extensions', {});
    let id = null;
    for (const line of mcp.text(r).split('\n')) {
      if (line.includes(EXT_NAME)) id = (line.match(/id=([a-p]{32})/) ?? [])[1] ?? null;
    }
    return id;
  };
  let extId = await findExtId();
  if (!extId) {
    const r = await mcp.call('install_extension', { path: EXT_PATH }, 60000);
    console.log('install_extension:', mcp.text(r).trim());
    extId = await findExtId();
  }
  if (!extId) throw new Error('extension not installed');
  // Persistent profile + path-derived extension id: Chrome may serve a stale cached SW script — always reload.
  await mcp.call('reload_extension', { id: extId }, 60000);
  await sleep(2000);
  console.log('extension ready:', extId);

  const np = mcp.text(await mcp.call('new_page', { url: CASES[0].url }, 90000));
  let pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  if (!Number.isFinite(pageId)) throw new Error(`cannot resolve pageId from:\n${np}`);

  for (const c of CASES) {
    console.log(`\n== ${c.name} ==\n   ${c.url}`);
    await mcp.call('navigate_page', { pageId, type: 'url', url: c.url }, 90000);
    await sleep(4000);

    let res = await sendToActiveTab({ type: 'GET_PROBLEM_INFO' }).catch((e) => ({
      ok: false,
      error: e.message.slice(0, 200),
    }));
    if (res?.ok !== true) {
      await sleep(2500);
      res = await sendToActiveTab({ type: 'GET_PROBLEM_INFO' }).catch((e) => ({
        ok: false,
        error: e.message.slice(0, 200),
      }));
    }
    writeFileSync(path.join(ARTIFACTS, 'leetcode-info.json'), JSON.stringify(res, null, 2));
    console.log('   ', JSON.stringify(res));

    const slugOk = res?.slug === c.slug && res?.isProblemPage === true;
    check(`slug 解析 [${c.slug}]`, slugOk, `got slug=${res?.slug} isProblemPage=${res?.isProblemPage}`);
    if (c.strict) {
      const gotTitle = res?.translatedTitle ?? res?.title ?? '';
      check('标题提取', typeof gotTitle === 'string' && gotTitle.includes(c.titleIncludes),
        `got "${gotTitle}" (source=${res?.source})`);
      check('难度提取', c.difficulty ? res?.difficultyCn === c.difficulty : !!res?.difficultyCn,
        `got ${res?.difficultyCn ?? 'null'} (raw=${res?.difficulty}, source=${res?.source})`);
    } else {
      const gotTitle = res?.translatedTitle ?? res?.title ?? null;
      check('标题提取（参考）', !!gotTitle && gotTitle.includes(c.titleIncludes),
        gotTitle ? `got "${gotTitle}" (source=${res?.source})` : 'null — 未登录/页面形态限制，仅供参考');
    }
  }

  const failed = results.filter((r) => !r.pass);
  writeFileSync(
    path.join(ARTIFACTS, 'leetcode-summary.json'),
    JSON.stringify({ checks: results, pass: failed.length === 0 }, null, 2),
  );
  console.log(`\n== LEETCODE TEST: ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ==`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}
