import type { PageProblem } from './page-readers';
import { difficultyOf, PLATFORMS, problemLabel, type PlatformId } from './platforms';

const MAX_STATEMENT = 40000;

/**
 * 题面 HTML 转纯文本：上下标写成 ^、_（10<sup>4</sup> 不能变成 104），
 * 牛客的公式图片（/equation?tex=…）还原成 $…$，其他图片留个占位
 */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((element) => element.remove());
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    let tex = '';
    if (src.includes('/equation?')) {
      // alt 里的 LaTeX 有时引号没转义、被截断，地址里的 tex 参数才完整
      try { tex = new URL(src, 'https://www.nowcoder.com/').searchParams.get('tex') ?? ''; } catch { /* 用 alt */ }
      tex = (tex || img.getAttribute('alt') || '').trim();
    }
    // \hspace{15pt} 之类只是排版留白
    img.replaceWith(!src.includes('/equation?') ? '[图片]' : !tex || /^\\[hv]space\*?\{[^}]*\}$/.test(tex) ? '' : `$${tex}$`);
  });
  doc.querySelectorAll('sup').forEach((element) => element.prepend('^'));
  doc.querySelectorAll('sub').forEach((element) => element.prepend('_'));
  doc.querySelectorAll('p, div, pre, li, br, tr, h1, h2, h3, h4, h5, h6').forEach((element) => element.append('\n'));
  return (doc.body.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface AgentProblem {
  platform: PlatformId;
  number: string | null;
  title: string;
  difficulty: string | null;
  mode?: 'core' | 'acm';
  tags?: string[];
  companies?: string[];
  timeLimitMs?: number | null;
  memoryLimitMb?: number | null;
  url: string;
  statement: string;
  samples?: { input: string; output: string; note?: string }[];
}

const duration = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`);

/** 对话开头那条题目信息：模型只从这里拿题目，后续提问不再读题 */
export function problemMessage(problem: AgentProblem): string {
  const statement = problem.statement.length > MAX_STATEMENT
    ? `${problem.statement.slice(0, MAX_STATEMENT)}\n…（题面过长，后面的内容没有读取）`
    : problem.statement;
  const limits = [
    problem.timeLimitMs ? `时间限制：${duration(problem.timeLimitMs)}` : null,
    problem.memoryLimitMb ? `内存限制：${problem.memoryLimitMb} MB` : null,
  ].filter(Boolean).join('；');
  const samples = (problem.samples ?? []).flatMap((sample, index) => [
    '', `样例 ${index + 1}`, '输入：', sample.input, '输出：', sample.output,
    ...(sample.note?.trim() ? ['说明：', htmlToText(sample.note)] : []),
  ]);
  return [
    '当前题目信息',
    `平台：${PLATFORMS[problem.platform].name}`,
    `题目：${problemLabel(problem.number, problem.title)}`,
    problem.difficulty ? `难度：${problem.difficulty}` : null,
    problem.mode === 'core' ? '答题模式：核心代码模式，只实现题目给定的函数，不用处理输入输出'
      : problem.mode === 'acm' ? '答题模式：ACM 模式，完整程序要自己读取输入，并按要求的格式输出' : null,
    problem.tags?.length ? `标签：${problem.tags.join('、')}` : null,
    problem.companies?.length ? `来源：${problem.companies.join('、')}` : null,
    limits || null,
    `题目链接：${problem.url}`,
    '',
    statement,
    ...samples,
  ].filter((line) => line !== null).join('\n');
}

/** 页面里读到的题目（codefun2000、牛客）整理成题目信息 */
export function pageProblemMessage(platform: PlatformId, url: string, problem: PageProblem) {
  const parts = problem.format === 'markdown' ? [problem.statement.trim()] : [
    htmlToText(problem.statement),
    problem.inputDesc.trim() ? `输入描述：\n${htmlToText(problem.inputDesc)}` : '',
    problem.outputDesc.trim() ? `输出描述：\n${htmlToText(problem.outputDesc)}` : '',
  ];
  return problemMessage({
    platform, url, number: problem.number, title: problem.title,
    // 顶栏徽标是「难度 3」，题目信息里写「难度：3」
    difficulty: difficultyOf(platform, problem.difficulty)?.label.replace(/^难度 /, '') ?? null,
    mode: problem.mode, tags: problem.tags, companies: problem.companies,
    timeLimitMs: problem.timeLimitMs, memoryLimitMb: problem.memoryLimitMb,
    statement: parts.filter(Boolean).join('\n\n'), samples: problem.samples,
  });
}
