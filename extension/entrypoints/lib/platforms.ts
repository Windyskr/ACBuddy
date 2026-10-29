// 支持的刷题网站：哪些页面是题目页、题目编号怎么取、题目链接怎么拼。
// 新平台第一版只接 AI 助手（读题、读代码、标出错误行）；自动记录、计时、心得卡和作答记录目前只有力扣
export type PlatformId = 'leetcode' | 'codefun' | 'nowcoder';
export type DifficultyTone = 'easy' | 'medium' | 'hard';
export interface Difficulty { label: string; tone: DifficultyTone | null }

export interface Platform {
  id: PlatformId;
  name: string;
  sites: readonly string[];
  /** 题目页的路径，第 1 个分组是题目编号；页面里的编辑器工具也用它核对题目没切换 */
  path: RegExp;
  problemUrl: (site: string, id: string) => string;
  /** 有网站端记录：自动记录作答、计时、心得卡、作答记录和判题结果工具 */
  tracked: boolean;
}

export const PLATFORMS: Record<PlatformId, Platform> = {
  leetcode: {
    id: 'leetcode', name: '力扣', sites: ['leetcode.cn', 'leetcode.com'],
    path: /\/problems\/([a-z0-9-]+)/i,
    problemUrl: (site, id) => `https://${site}/problems/${id}/`,
    tracked: true,
  },
  codefun: {
    id: 'codefun', name: 'CodeFun2000', sites: ['codefun2000.com'],
    // /p/P1559 会跳到做题页 /ide/P1559
    path: /^\/(?:ide|p)\/(P\d+)(?:\/|$)/i,
    problemUrl: (_site, id) => `https://codefun2000.com/ide/${id}`,
    tracked: false,
  },
  nowcoder: {
    id: 'nowcoder', name: '牛客', sites: ['www.nowcoder.com'],
    // 只认题库的在线编程页：笔试、考试页面不在其中，AI 助手不该出现在那里
    path: /^\/practice\/([0-9a-f]{32})(?:\/|$)/i,
    problemUrl: (_site, id) => `https://www.nowcoder.com/practice/${id}`,
    tracked: false,
  },
};

/** 一道题：平台、所在站点、题目编号，以及跨平台唯一的题目键 */
export interface ProblemRef { platform: PlatformId; site: string; id: string; key: string }

export function problemOf(url: string | undefined): ProblemRef | null {
  if (!url) return null;
  try {
    const { protocol, hostname, pathname } = new URL(url);
    if (protocol !== 'https:') return null;
    const platform = Object.values(PLATFORMS).find((item) => item.sites.includes(hostname));
    const id = platform ? pathname.match(platform.path)?.[1] : undefined;
    return platform && id ? { platform: platform.id, site: hostname, id, key: `${platform.id}:${id}` } : null;
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

/** 各平台的难度换成统一的文字和颜色档：力扣是 简单/中等/困难，牛客是 1–5 档，codefun2000 是数字 */
export function difficultyOf(platform: PlatformId, raw: unknown): Difficulty | null {
  if (raw == null || raw === '') return null;
  if (platform === 'nowcoder') {
    const label = NOWCODER_LEVELS[Number(raw) - 1];
    return label ? { label, tone: TONE[label] ?? null } : null;
  }
  if (platform === 'codefun') {
    const level = Number(raw);
    return Number.isFinite(level) && level > 0 ? { label: `难度 ${level}`, tone: null } : null;
  }
  const label = String(raw);
  return { label, tone: TONE[label] ?? null };
}

/** 侧边栏顶栏显示的题目 */
export interface ProblemHeader extends ProblemRef {
  url: string;
  number: string | null;
  title: string;
  difficulty: Difficulty | null;
}

export const problemLabel = (number: string | null, title: string) =>
  number ? `${number}${/^\d+$/.test(number) ? '.' : ''} ${title}` : title;
