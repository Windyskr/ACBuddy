import type { PlatformId } from './platforms';

// 在题目页面的 MAIN world 里读题。chrome.scripting 会把函数序列化后注入页面，所以每个函数的依赖都要写在函数里。
// 尽量读页面已经加载好的数据：codefun2000 有防爬，牛客在 Vuex 里，AtCoder、AcWing 是服务端渲染的 HTML；
// 洛谷站内换题是单页跳转，页面里的数据会过期，过期时按页面自己的方式再取一次

export interface PageSample { input: string; output: string; note?: string }
export interface PageProblem {
  title: string;
  number: string | null;
  difficulty: number | string | null;
  tags: string[];
  /** 来源：公司、比赛、年份 */
  companies: string[];
  timeLimitMs: number | null;
  memoryLimitMb: number | null;
  mode: 'core' | 'acm';
  /** codefun2000、洛谷是 Markdown，其余是页面上的 HTML */
  format: 'markdown' | 'html';
  statement: string;
  inputDesc: string;
  outputDesc: string;
  samples: PageSample[];
}
/** unavailable：标题、难度读到了，但题面看不了（比如没登录），顶栏照常显示，对话读不了题 */
export type PageReadResult = { problem: PageProblem; unavailable?: string } | { error: string; retry?: boolean };

export function readCodefun(id: string): PageReadResult {
  try {
    const page = window as unknown as Record<string, any>;
    const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
    const names = (value: unknown) => (Array.isArray(value) ? value.map(text).filter((item) => item.trim()) : []);
    const positive = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
    const pdoc = page.UiContext?.pdoc;
    if (!pdoc) return { error: '题目页面还没加载完', retry: true };
    if (text(pdoc.pid).toUpperCase() !== id.toUpperCase()) return { error: '题目已经切换，请重新打开对话' };
    let content: unknown = pdoc.content;
    try { if (typeof content === 'string') content = JSON.parse(content); } catch { /* 本身就是 Markdown */ }
    const byLang = content && typeof content === 'object' ? (content as Record<string, unknown>) : null;
    const statement = byLang
      ? text(byLang.ZhContent || byLang.zh || Object.values(byLang).find((value) => typeof value === 'string' && value.trim()))
      : text(content);
    // pdoc 里还有题解原文（textSol / textSolHTML），不读
    const unavailable = statement.trim() ? undefined : (page.UserContext?._id ?? 0) > 0
      ? `题面暂时无法查看${pdoc.lockOverlay?.title ? `（${text(pdoc.lockOverlay.title)}）` : ''}`
      : '登录 CodeFun2000 后才能读取题面';
    return {
      unavailable,
      problem: {
        title: text(pdoc.title), number: text(pdoc.pid) || null, difficulty: positive(pdoc.difficulty),
        tags: names(pdoc.alg_tag), companies: names(pdoc.tag),
        timeLimitMs: positive(pdoc.config?.timeMax), memoryLimitMb: positive(pdoc.config?.memoryMax),
        mode: 'acm', format: 'markdown', statement, inputDesc: '', outputDesc: '', samples: [],
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '读取题目失败' };
  }
}

export function readNowcoder(id: string): PageReadResult {
  try {
    const page = window as unknown as Record<string, any>;
    const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
    const positive = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
    const state = page.store?.state;
    const coding = state?.codingProblem;
    // 地址里的编号先写进 store，题目内容随后才由接口返回；切题时也一样
    if (!coding || !state.question || !text(coding.title || state.question.title).trim()) return { error: '题目页面还没加载完', retry: true };
    if (text(state.uuid).toLowerCase() !== id.toLowerCase()) return { error: '题目还在加载，请稍后重试', retry: true };
    const question = state.question;
    const samples: PageSample[] = Array.isArray(question.samples) && question.samples.length
      ? question.samples.map((item: Record<string, unknown>) => ({ input: text(item.input), output: text(item.output), note: text(item.note) }))
      : coding.inputSample || coding.outputSample ? [{ input: text(coding.inputSample), output: text(coding.outputSample) }] : [];
    const tags = Array.isArray(state.questionTags) ? state.questionTags : [];
    const memoryKb = positive(coding.memoryLimit ?? question.memoryLimit);
    const timeSec = positive(coding.timeLimit ?? question.timeLimit);
    return {
      problem: {
        title: text(coding.title || question.title), number: null, difficulty: positive(question.difficulty),
        tags: tags.filter((tag: Record<string, unknown>) => !tag.companyTag).map((tag: Record<string, unknown>) => text(tag.name)).filter(Boolean),
        companies: tags.filter((tag: Record<string, unknown>) => tag.companyTag).map((tag: Record<string, unknown>) => text(tag.name)).filter(Boolean),
        timeLimitMs: timeSec ? timeSec * 1000 : null, memoryLimitMb: memoryKb ? Math.round(memoryKb / 1024) : null,
        // 核心代码模式只写函数；否则是 ACM 模式，自己读输入、写输出
        mode: coding.mainModeProblem === true || coding.mainModeProblem === 'true' ? 'core' : 'acm',
        format: 'html', statement: text(coding.content || question.content),
        inputDesc: text(coding.inputDesc || question.inputDesc), outputDesc: text(coding.outputDesc || question.outputDesc), samples,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '读取题目失败' };
  }
}

export async function readLuogu(id: string): Promise<PageReadResult> {
  try {
    const page = window as unknown as Record<string, any>;
    const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
    let context: any = null;
    try { context = JSON.parse(document.querySelector('script#lentille-context')?.textContent ?? 'null'); } catch { /* 下面再取 */ }
    // 站内换题是单页跳转：页面里的数据还是上一题的，用页面自己的接口再取一次，取到的留在页面里给下次用
    if (context?.data?.problem?.pid !== id) {
      if (page.__acbLuoguContext?.data?.problem?.pid === id) context = page.__acbLuoguContext;
      else {
        const response = await fetch(`/problem/${encodeURIComponent(id)}`, { headers: { 'x-lentille-request': 'content-only' }, credentials: 'same-origin' });
        if (!response.ok) return { error: '读取洛谷题目失败，请刷新页面后重试' };
        context = await response.json();
        page.__acbLuoguContext = context;
      }
    }
    const problem = context?.data?.problem;
    if (!problem || problem.pid !== id) return { error: '题目页面还没加载完', retry: true };
    // contenu 是当前语言的版本（外站题就是洛谷的中文翻译），没有时用原文
    const content = problem.contenu ?? problem.content ?? {};
    const section = (title: string, body: unknown) => (text(body).trim() ? `## ${title}\n\n${text(body).trim()}` : '');
    const statement = [
      section('题目背景', content.background), section('题目描述', content.description),
      section('输入格式', content.formatI), section('输出格式', content.formatO), section('说明/提示', content.hint),
    ].filter(Boolean).join('\n\n');
    // 标签在页面数据里只有编号；名字表浏览器缓存 12 小时，题目页加载时已经取过
    const tags: string[] = [];
    const sources: string[] = [];
    try {
      const all = await (await fetch('/_lfe/tags', { credentials: 'same-origin' })).json();
      const byId = new Map<number, { name: string; type: number }>((all.tags ?? []).map((tag: { id: number; name: string; type: number }) => [tag.id, tag]));
      for (const tagId of Array.isArray(problem.tags) ? problem.tags : []) {
        const tag = byId.get(tagId);
        // 类型 2 是算法，3 是来源，4 是年份
        if (tag?.type === 2) tags.push(tag.name);
        else if (tag?.type === 3 || tag?.type === 4) sources.push(tag.name);
      }
    } catch { /* 标签读不到不影响读题 */ }
    const max = (values: unknown) => {
      const numbers = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
      return numbers.length ? Math.max(...numbers) : null;
    };
    const memoryKb = max(problem.limits?.memory);
    return {
      problem: {
        title: text(content.name || problem.title) || id, number: id,
        difficulty: Number.isFinite(Number(problem.difficulty)) ? Number(problem.difficulty) : null,
        tags, companies: sources, timeLimitMs: max(problem.limits?.time), memoryLimitMb: memoryKb ? Math.round(memoryKb / 1024) : null,
        mode: 'acm', format: 'markdown', statement, inputDesc: '', outputDesc: '',
        samples: (Array.isArray(problem.samples) ? problem.samples : []).map((sample: unknown[]) => ({ input: text(sample?.[0]), output: text(sample?.[1]) })),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '读取题目失败' };
  }
}

export function readAtcoder(id: string): PageReadResult {
  try {
    const root = document.querySelector('#task-statement');
    if (!root) return { error: '题目页面还没加载完', retry: true };
    // 日文、英文各一份：有英文就用英文
    const lang = root.querySelector('.lang-en') ?? root.querySelector('.lang-ja') ?? root;
    const parts: string[] = [];
    const samples: PageSample[] = [];
    let input: string | null = null;
    for (const part of lang.querySelectorAll('.part')) {
      const section = part.cloneNode(true) as Element;
      section.querySelectorAll('.btn-copy, .div-btn-copy').forEach((button) => button.remove());
      const heading = section.querySelector('h3')?.textContent?.trim() ?? '';
      const pre = section.querySelector('pre');
      if (/^(Sample Input|入力例)/.test(heading)) {
        input = pre?.textContent ?? '';
      } else if (/^(Sample Output|出力例)/.test(heading)) {
        section.querySelector('h3')?.remove();
        pre?.remove();
        samples.push({ input: input ?? '', output: pre?.textContent ?? '', note: section.innerHTML });
        input = null;
      } else {
        parts.push(section.innerHTML);
      }
    }
    const limits = [...document.querySelectorAll('#main-container p')].map((p) => p.textContent ?? '').find((line) => /Limit|制限/.test(line)) ?? '';
    const seconds = Number(limits.match(/([\d.]+)\s*sec/)?.[1]);
    const mebibytes = Number(limits.match(/(\d+)\s*MiB/)?.[1]);
    // 标题是「A - N-choice question」，编号写成「ABC300 A」
    const title = document.title.replace(/^[A-Z][A-Za-z0-9]*\s+-\s+/, '');
    return {
      problem: {
        title: title || id, number: id.replace(/_([a-z0-9]+)$/i, ' $1').toUpperCase(), difficulty: null,
        tags: [], companies: [], timeLimitMs: seconds ? Math.round(seconds * 1000) : null, memoryLimitMb: mebibytes || null,
        mode: 'acm', format: 'html', statement: parts.join('\n'), inputDesc: '', outputDesc: '', samples,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '读取题目失败' };
  }
}

export function readAcwing(id: string): PageReadResult {
  try {
    const content = document.querySelector('.main-martor-content');
    const heading = document.querySelector('.problem-content-title')?.textContent?.trim() ?? '';
    if (!content || !heading) return { error: '题目页面还没加载完', retry: true };
    // 标题是「1. A + B」；样例写在题面里
    const match = heading.match(/^(\d+)\.\s*(.+)$/);
    const level = [...document.querySelectorAll('span.label')].map((label) => label.textContent?.trim() ?? '').find((label) => /^(简单|中等|困难)$/.test(label));
    return {
      problem: {
        title: match?.[2] ?? heading, number: match?.[1] ?? id, difficulty: level ?? null,
        tags: [], companies: [], timeLimitMs: null, memoryLimitMb: null,
        mode: 'acm', format: 'html', statement: content.innerHTML, inputDesc: '', outputDesc: '', samples: [],
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '读取题目失败' };
  }
}

export type PageReader = (id: string) => PageReadResult | Promise<PageReadResult>;

/** 各平台的读题函数；力扣由内容脚本读 */
export const pageReaders: Record<Exclude<PlatformId, 'leetcode'>, PageReader> = {
  codefun: readCodefun, nowcoder: readNowcoder, luogu: readLuogu, atcoder: readAtcoder, acwing: readAcwing,
};
