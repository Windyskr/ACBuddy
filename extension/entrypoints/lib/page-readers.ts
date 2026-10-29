// 在题目页面的 MAIN world 里读题（chrome.scripting 会序列化这个函数，依赖都写在函数里）。
// 只读页面已经加载好的数据，不另外发请求：codefun2000 有防爬，牛客的数据都在 Vuex 里

export interface PageSample { input: string; output: string; note?: string }
export interface PageProblem {
  title: string;
  number: string | null;
  difficulty: number | null;
  tags: string[];
  companies: string[];
  timeLimitMs: number | null;
  memoryLimitMb: number | null;
  mode: 'core' | 'acm';
  /** codefun2000 是 Markdown（样例写在里面），牛客是 HTML */
  format: 'markdown' | 'html';
  statement: string;
  inputDesc: string;
  outputDesc: string;
  samples: PageSample[];
}
/** unavailable：标题、难度读到了，但题面看不了（比如没登录），顶栏照常显示，对话读不了题 */
export type PageReadResult = { problem: PageProblem; unavailable?: string } | { error: string; retry?: boolean };

export function readProblemPage(platform: 'codefun' | 'nowcoder', id: string): PageReadResult {
  try {
    const page = window as unknown as Record<string, any>;
    const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
    const names = (value: unknown) => (Array.isArray(value) ? value.map(text).filter((item) => item.trim()) : []);
    const positive = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

    if (platform === 'codefun') {
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
    }

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
