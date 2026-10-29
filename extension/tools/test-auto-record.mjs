import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

// 会用 profile 里的力扣登录态真实提交；加 --site=leetcode.com 跑国际版（需先跑过国内版）
const EXT_NAME = 'ACBuddy';
const SITE = 'https://acbuddy.pages.dev';
const LEETCODE_SITE = process.argv.includes('--site=leetcode.com') ? 'leetcode.com' : 'leetcode.cn';
const IS_CN = LEETCODE_SITE === 'leetcode.cn';
const PROBLEM_URL = `https://${LEETCODE_SITE}/problems/two-sum/`;
const PROBLEM_TITLE = IS_CN ? '两数之和' : 'Two Sum';
const SUBMIT_BUTTON = IS_CN ? 'button "提交"' : 'button "Submit"';
const CODE = {
  cpp: {
    lang: 'cpp',
    pass: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        unordered_map<int, int> seen;\n        for (int i = 0; i < (int)nums.size(); i++) {\n            auto it = seen.find(target - nums[i]);\n            if (it != seen.end()) return {it->second, i};\n            seen[nums[i]] = i;\n        }\n        return {};\n    }\n};',
    fail: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        return {0, 0};\n    }\n};',
  },
  python: {
    lang: 'python3',
    pass: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        seen = {}\n        for i, x in enumerate(nums):\n            if target - x in seen:\n                return [seen[target - x], i]\n            seen[x] = i\n        return []\n',
    fail: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        return [0, 0]\n',
  },
  java: {
    lang: 'java',
    pass: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        Map<Integer, Integer> seen = new HashMap<>();\n        for (int i = 0; i < nums.length; i++) {\n            Integer j = seen.get(target - nums[i]);\n            if (j != null) return new int[]{j, i};\n            seen.put(nums[i], i);\n        }\n        return new int[0];\n    }\n}',
    fail: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        return new int[]{0, 0};\n    }\n}',
  },
};
const setCodeFn = (kind) => `() => {
  const models = (window.monaco && window.monaco.editor.getModels()) || [];
  const t = models.find((m) => (m.getValue() || '').includes('class Solution'));
  if (!t) return 'no-model';
  const table = ${JSON.stringify(CODE)};
  const entry = table[t.getLanguageId()];
  if (!entry) return 'unsupported:' + t.getLanguageId();
  t.setValue(entry[${JSON.stringify(kind)}]);
  return entry.lang;
}`;
const NOTE = '自动化端到端：哈希表一遍过，注意重复 key';

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
    return { id: Number(m[1]), desc: m[2].replace(/\s*\[selected\]\s*$/, '') };
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
    console.log('install_extension:', mcp.text(r).trim());
    extId = await findExtId();
  }
  await mcp.call('reload_extension', { id: extId }, 60000);
  await sleep(2000);

  const np = mcp.text(await mcp.call('new_page', { url: PROBLEM_URL, timeout: 60000 }, 90000));
  const pageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await sleep(4000);

  await mcp.call('trigger_extension_action', { id: extId }, 60000);
  await sleep(1500);
  const lp = mcp.text(await mcp.call('list_pages', {}));
  const panelId = pageLines(lp).find(
    (p) => p.desc.includes(`chrome-extension://${extId}`) && p.desc.includes('sidepanel'),
  )?.id ?? null;
  check('side_panel_opened', panelId != null, `pageId=${panelId}`);

  const snapshot = async () =>
    mcp.text(await mcp.call('take_snapshot', { pageId: panelId }, 60000));

  const me0 = unwrap(
    mcp.text(
      await mcp.call(
        'evaluate_script',
        { pageId: panelId, function: `async () => { const r = await fetch('${SITE}/api/auth/me', { credentials: 'include' }); return { status: r.status }; }` },
        60000,
      ),
    ),
  );
  // 登录要过 Turnstile，脚本登不上：会话过期了就先手动登录（见 extension/README.md）
  if (me0?.status !== 200) {
    throw new Error('测试 Profile 没有登录 ACBuddy，请先用普通 Chrome 打开这个 Profile 在网站上登录测试账号');
  }
  const pageSnapshot = async () =>
    mcp.text(await mcp.call('take_snapshot', { pageId }, 60000));
  const uidOf = (text, label) =>
    (text.split('\n').find((l) => l.includes(label) && /uid=/.test(l))?.match(/\b(?:uid|ref)=([A-Za-z0-9_\-]+)/) ?? [])[1] ?? null;

  let snap = await snapshot();
  for (const deadline = Date.now() + 15000; !snap.includes('计时') && Date.now() < deadline;) {
    await sleep(1000);
    snap = await snapshot();
  }
  writeFileSync(path.join(ARTIFACTS, 'auto-record-panel-snapshot-1.txt'), snap);
  check('login_state_shown', snap.includes('计时') && !snap.includes('未登录'), 'acb_session cookie attached by extension page');
  check('problem_auto_loaded', snap.includes(PROBLEM_TITLE), 'GET_PROBLEM_INFO on panel mount');
  check(
    'auto_flow_ui',
    snap.includes('计时') && !snap.includes('上报通过'),
    '计时/进度展示在；手动上报按钮已移除',
  );

  // MCP 的 evaluate_script 在非选中页上要求先有 snapshot 建立上下文
  await pageSnapshot();

  const serverState = async () =>
    unwrap(
      mcp.text(
        await mcp.call(
          'evaluate_script',
          {
            pageId: panelId,
            function: `async () => {
              const r = await fetch('${SITE}/api/progress/leetcode/two-sum', { credentials: 'include' });
              const j = await r.json();
              const attempts = j?.data?.attempts ?? [];
              const a = attempts[0] ?? null;
              const p = j?.data?.progress;
              return { status: r.status, attemptCount: p?.attemptCount ?? null,
                       progressNote: p?.note ?? null, title: p?.title ?? null, difficulty: p?.difficulty ?? null,
                       sites: [...new Set(attempts.map((x) => x.site))],
                       latest: a && { id: a.id, site: a.site, result: a.result, verdict: a.verdict, note: a.note, language: a.language, timeMs: a.timeMs, submissionId: a.submissionId } };
            }`,
          },
          60000,
        ),
      ),
    );
  const before = await serverState();
  check('server_baseline_ok', before?.status === 200, JSON.stringify(before).slice(0, 120));

  // 不能 fetch 直发 /submit/：该接口判的是编辑器草稿而非 body 里的代码
  const lang = unwrap(mcp.text(await mcp.call('evaluate_script', { pageId, function: setCodeFn('pass') }, 60000)));
  check('code_set', ['cpp', 'python3', 'java'].includes(lang), `editor language → ${lang}`);
  await sleep(1000);
  const psnapPre = await pageSnapshot();
  const submitUid = uidOf(psnapPre, SUBMIT_BUTTON);
  check('submit_button_found', submitUid != null, `uid=${submitUid}`);
  if (submitUid != null) {
    await mcp.call('click', { pageId, uid: submitUid }, 60000);
  }
  let afterPass = null;
  const judgeDeadline = Date.now() + 60000;
  while (Date.now() < judgeDeadline) {
    await sleep(1000);
    afterPass = await serverState();
    if (afterPass?.attemptCount === (before?.attemptCount ?? 0) + 1) break;
  }
  check(
    'real_submitted_accepted',
    afterPass?.latest?.result === 'pass' && afterPass?.attemptCount === (before?.attemptCount ?? 0) + 1,
    `attemptCount=${afterPass?.attemptCount} latest=${JSON.stringify(afterPass?.latest)}`,
  );
  writeFileSync(path.join(ARTIFACTS, 'auto-record-progress.json'), JSON.stringify(afterPass, null, 2));
  check(
    'server_attempt_pass',
    afterPass?.latest?.result === 'pass' &&
      afterPass?.latest?.site === LEETCODE_SITE &&
      afterPass?.latest?.verdict === 'Accepted' &&
      afterPass?.latest?.language === lang &&
      typeof afterPass?.latest?.submissionId === 'string' &&
      /^\d+$/.test(afterPass.latest.submissionId) &&
      afterPass?.latest?.note == null &&
      afterPass?.attemptCount === (before?.attemptCount ?? 0) + 1,
    JSON.stringify(afterPass?.latest),
  );
  check('server_time_reasonable', afterPass?.latest?.timeMs >= 0 && afterPass?.latest?.timeMs <= 86400000, `timeMs=${afterPass?.latest?.timeMs}`);
  check('server_problem_meta', afterPass?.title === PROBLEM_TITLE && afterPass?.difficulty === 'EASY', `title=${afterPass?.title} difficulty=${afterPass?.difficulty}`);

  const psnap = await pageSnapshot();
  writeFileSync(path.join(ARTIFACTS, 'auto-record-page-card.txt'), psnap);
  const cardNote = uidOf(psnap, '本次心得');
  const cardSave = uidOf(psnap, '保存心得');
  check('card_shown', psnap.includes('通过 ✓') && cardNote != null && cardSave != null, `note=${cardNote} save=${cardSave}`);
  if (cardNote != null && cardSave != null) {
    await mcp.call('fill', { pageId, uid: cardNote, value: NOTE }, 60000);
    await mcp.call('click', { pageId, uid: cardSave }, 60000);
    await sleep(2500);
  }

  snap = await snapshot();
  writeFileSync(path.join(ARTIFACTS, 'auto-record-panel-snapshot-2.txt'), snap);
  check('panel_note_status', snap.includes('心得已保存'), 'panel refreshed via NOTE_SAVED broadcast');
  check('timer_stopped_after_pass', snap.includes('计时已停') && snap.includes('button "开始计时"'), '通过后显示「计时已停」');

  const afterNote = await serverState();
  check(
    'server_note_saved',
    afterNote?.latest?.note === NOTE,
    `latest.note=${JSON.stringify(afterNote?.latest?.note)}`,
  );
  check(
    'server_current_note_untouched',
    (afterNote?.progressNote ?? '') === (before?.progressNote ?? ''),
    `progress.note before=${JSON.stringify(before?.progressNote)} after=${JSON.stringify(afterNote?.progressNote)}`,
  );

  await mcp.call('evaluate_script', { pageId, function: setCodeFn('fail') }, 60000);
  await sleep(1000);
  const psnapFail = await pageSnapshot();
  const submitUidFail = uidOf(psnapFail, SUBMIT_BUTTON);
  if (submitUidFail != null) {
    await mcp.call('click', { pageId, uid: submitUidFail }, 60000);
  }
  let afterFail = null;
  const failDeadline = Date.now() + 60000;
  while (Date.now() < failDeadline) {
    await sleep(3000);
    afterFail = await serverState();
    if (afterFail?.attemptCount === (afterNote?.attemptCount ?? 0) + 1) break;
  }
  snap = await snapshot();
  writeFileSync(path.join(ARTIFACTS, 'auto-record-panel-snapshot-3.txt'), snap);
  check('panel_auto_reported_fail', snap.includes('未通过 ✗'), 'status after real fail submit');
  const timerMin = (snap.match(/"(\d{2}):(\d{2})"/) ?? [])[1];
  check('timer_restarted_after_fail', timerMin === '00' && snap.includes('button "暂停计时"'), `入账后计时分钟=${timerMin ?? '未找到'}`);
  check(
    'server_attempt_fail',
    afterFail?.latest?.result === 'fail' && afterFail?.latest?.site === LEETCODE_SITE &&
      afterFail?.latest?.verdict === 'Wrong Answer' && afterFail?.attemptCount === (afterNote?.attemptCount ?? 0) + 1,
    JSON.stringify(afterFail?.latest),
  );
  if (!IS_CN) {
    check('progress_shared_across_sites', afterFail?.sites?.includes('leetcode.cn') && afterFail?.sites?.includes('leetcode.com'), `sites=${JSON.stringify(afterFail?.sites)}`);
  }

  const grabConsole = async (name, args, opts = {}) => {
    try {
      const r = await mcp.call('list_console_messages', args, 60000);
      const t = mcp.text(r);
      writeFileSync(path.join(ARTIFACTS, `auto-record-console-${name}.txt`), t);
      const errLines = t
        .split('\n')
        .filter((l) => /^\s*\[?error\b|\[ERROR\]/i.test(l))
        .filter((l) => !/Chrome DevTools MCP/i.test(l))
        .filter((l) => !(opts.ignoreNetResourceErrors && /Failed to load resource/i.test(l)))
        .filter((l) => !/status of 401/i.test(l));
      return { ok: true, errors: errLines };
    } catch (e) {
      return { ok: false, errors: [], note: e.message.slice(0, 150) };
    }
  };
  const fmtErrors = (c) => (c.ok ? (c.errors.join(' | ') || 'no errors') : c.note);
  const conPanel = await grabConsole('panel', { pageId: panelId });
  const conPage = await grabConsole('page', { pageId }, { ignoreNetResourceErrors: true });
  check('console_panel_clean', conPanel.ok && conPanel.errors.length === 0, fmtErrors(conPanel));
  check('console_page_clean', conPage.ok && conPage.errors.length === 0, fmtErrors(conPage));

  const failed = results.filter((r) => !r.pass);
  writeFileSync(
    path.join(ARTIFACTS, 'auto-record-summary.json'),
    JSON.stringify({ checks: results, pass: failed.length === 0 }, null, 2),
  );
  console.log(`\n== AUTO RECORD E2E (${LEETCODE_SITE}): ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ==`);
  if (failed.length) console.log(failed.map((f) => `${f.name}: ${f.detail}`).join('\n'));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}
