// 支持的刷题网站：哪些页面是题目页、题目编号怎么取、题目链接怎么拼、代码框能做什么。
// 力扣以外的平台只接 AI 助手（读题、读代码、标出错误行）；自动记录、计时、心得卡和作答记录目前只有力扣
export type PlatformId = 'leetcode' | 'codefun' | 'nowcoder' | 'luogu' | 'atcoder' | 'acwing';
export type DifficultyTone = 'easy' | 'medium' | 'hard';
export interface Difficulty { label: string; tone: DifficultyTone | null }
/** 代码框能做什么：full 读代码并标出错误行，read 只能读 */
export type EditorSupport = 'full' | 'read';

export interface Platform {
  id: PlatformId;
  name: string;
  sites: readonly string[];
  /** 题目页的路径，第 1 个分组是题目编号；页面里的编辑器工具也用它核对题目没切换 */
  path: RegExp;
  problemUrl: (origin: string, match: RegExpMatchArray, id: string) => string;
  /** 有网站端记录：自动记录作答、计时、心得卡、作答记录和判题结果工具 */
  tracked: boolean;
  editor: EditorSupport;
}

// 题目页地址本身（去掉查询和锚点、末尾斜杠）
const samePage = (origin: string, match: RegExpMatchArray) => `${origin}${match[0].replace(/\/$/, '')}`;

export const PLATFORMS: Record<PlatformId, Platform> = {
  leetcode: {
    id: 'leetcode', name: '力扣', sites: ['leetcode.cn', 'leetcode.com'],
    path: /\/problems\/([a-z0-9-]+)/i,
    problemUrl: (origin, _match, id) => `${origin}/problems/${id}/`,
    tracked: true, editor: 'full',
  },
  codefun: {
    id: 'codefun', name: 'CodeFun2000', sites: ['codefun2000.com'],
    // /p/P1559 会跳到做题页 /ide/P1559
    path: /^\/(?:ide|p)\/(P\d+)(?:\/|$)/i,
    problemUrl: (origin, _match, id) => `${origin}/ide/${id}`,
    tracked: false, editor: 'full',
  },
  nowcoder: {
    id: 'nowcoder', name: '牛客', sites: ['www.nowcoder.com'],
    // 只认题库的在线编程页：笔试、考试页面不在其中，AI 助手不该出现在那里
    path: /^\/practice\/([0-9a-f]{32})(?:\/|$)/i,
    problemUrl: (origin, _match, id) => `${origin}/practice/${id}`,
    tracked: false, editor: 'full',
  },
  luogu: {
    id: 'luogu', name: '洛谷', sites: ['www.luogu.com.cn'],
    // 题号都以大写字母开头（P1001、B2001、CF1A、AT_abc300_a），/problem/list 不算
    path: /^\/problem\/([A-Z][A-Za-z0-9_]*)(?:\/|$)/,
    problemUrl: (origin, _match, id) => `${origin}/problem/${id}`,
    // 代码框在 IDE 模式里，是 CodeMirror 6：能读，加不了错误标记
    tracked: false, editor: 'read',
  },
  atcoder: {
    id: 'atcoder', name: 'AtCoder', sites: ['atcoder.jp'],
    path: /^\/contests\/[^/]+\/tasks\/([a-z0-9_]+)(?:\/|$)/i,
    problemUrl: samePage,
    // 代码框在题目页底部的提交区（登录后才有），是 Ace
    tracked: false, editor: 'full',
  },
  acwing: {
    id: 'acwing', name: 'AcWing', sites: ['www.acwing.com'],
    path: /^\/problem\/content\/(\d+)(?:\/|$)/,
    problemUrl: (origin, _match, id) => `${origin}/problem/content/${id}/`,
    tracked: false, editor: 'full',
  },
};

/** 一道题：平台、所在站点、题目编号、跨平台唯一的题目键，以及题目链接 */
export interface ProblemRef { platform: PlatformId; site: string; id: string; key: string; url: string }

export function problemOf(url: string | undefined): ProblemRef | null {
  if (!url) return null;
  try {
    const { protocol, hostname, origin, pathname } = new URL(url);
    if (protocol !== 'https:') return null;
    const platform = Object.values(PLATFORMS).find((item) => item.sites.includes(hostname));
    const match = platform ? pathname.match(platform.path) : null;
    if (!platform || !match) return null;
    const id = match[1]!;
    return { platform: platform.id, site: hostname, id, key: `${platform.id}:${id}`, url: platform.problemUrl(origin, match, id) };
  } catch {
    return null;
  }
}

/** 编辑器工具在页面里核对题目时用的规则（正则要以字符串传进页面） */
export const pathGuard = (problem: ProblemRef) => {
  const { path } = PLATFORMS[problem.platform];
  return { pattern: path.source, flags: path.flags, id: problem.id };
};

const TONE: Record<string, DifficultyTone> = { 入门: 'easy', 简单: 'easy', 中等: 'medium', 较难: 'hard', 困难: 'hard' };
const NOWCODER_LEVELS = ['入门', '简单', '中等', '较难', '困难'];
// 洛谷 1–7 档（0 是暂无评定）：红、橙算简单，黄、绿算中等，蓝、紫、黑算难
const LUOGU_LEVELS: [string, DifficultyTone][] = [
  ['入门', 'easy'], ['普及−', 'easy'], ['普及/提高−', 'medium'], ['普及+/提高', 'medium'],
  ['提高+/省选−', 'hard'], ['省选/NOI−', 'hard'], ['NOI/NOI+/CTSC', 'hard'],
];

/** 各平台的难度换成统一的文字和颜色档 */
export function difficultyOf(platform: PlatformId, raw: unknown): Difficulty | null {
  if (raw == null || raw === '') return null;
  const level = Number(raw);
  switch (platform) {
    case 'nowcoder': {
      const label = NOWCODER_LEVELS[level - 1];
      return label ? { label, tone: TONE[label] ?? null } : null;
    }
    case 'luogu': {
      const entry = LUOGU_LEVELS[level - 1];
      return entry ? { label: entry[0], tone: entry[1] } : null;
    }
    case 'codefun':
      return Number.isFinite(level) && level > 0 ? { label: `难度 ${level}`, tone: null } : null;
    default: {
      const label = String(raw);
      return { label, tone: TONE[label] ?? null };
    }
  }
}

/** 侧边栏顶栏显示的题目 */
export interface ProblemHeader extends ProblemRef {
  number: string | null;
  title: string;
  difficulty: Difficulty | null;
}

export const problemLabel = (number: string | null, title: string) =>
  number ? `${number}${/^\d+$/.test(number) ? '.' : ''} ${title}` : title;
