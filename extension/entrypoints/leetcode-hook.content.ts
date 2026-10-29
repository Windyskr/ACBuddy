import { judgeRecord, type JudgeRequest } from './lib/judge';

export default defineContentScript({
  matches: ['https://leetcode.cn/*', 'https://leetcode.com/*'],
  world: 'MAIN',
  main() {
    const w = window as unknown as Record<string, unknown>;
    if (w.__acbHookInstalled) return;
    w.__acbHookInstalled = true;

    const PROBLEM_RE = /\/problems\/([a-z0-9-]+)/;
    const JUDGE_RE = /check|submission/i;
    // 提交、运行的入队请求。力扣限流时回 429（空 body、无 Retry-After），服务端没有建任务，原样重发是安全的
    const ENQUEUE_RE = /\/problems\/([a-z0-9-]+)\/(submit|interpret_solution)\/?(\?|$)/;
    const RETRY_DELAYS_MS: number[] = [
      ...Array(3).fill(1_000),
      ...Array(5).fill(2_000),
      ...Array(5).fill(3_000),
    ];

    type SubmitDetail = {
      slug: string;
      result: 'pass' | 'fail';
      verdict: string;
      language?: string;
      submissionId?: string;
    };

    let lastSubmit: JudgeRequest | null = null;
    let lastRun: JudgeRequest | null = null;

    const post = (data: Record<string, unknown>) => {
      window.postMessage({ source: 'acb-leetcode-hook', ...data }, '*');
    };
    const emit = (d: SubmitDetail) => post({ kind: 'submit-result', ...d });

    const retryThrottled = async (action: 'submit' | 'run', first: Response, send: () => Promise<Response>) => {
      let res = first;
      let attempt = 0;
      while (res.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt++]!;
        void res.body?.cancel().catch(() => {});
        post({ kind: 'retry', action, attempt });
        await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          res = await send();
        } catch (error) {
          post({ kind: 'retry-end', action });
          throw error;
        }
      }
      if (attempt) post({ kind: 'retry-end', action });
      return res;
    };

    const inspect = (url: string, text: string | null | undefined) => {
      if (!text || !JUDGE_RE.test(url)) return;
      let j: Record<string, unknown> | null;
      try {
        j = JSON.parse(text);
      } catch {
        return;
      }
      const verdict = j?.status_msg;
      // 力扣判题完成时 state 为 "SUCCESS"；兼容 "FINISHED" 以防接口变动
      if (!j || (j.state !== 'SUCCESS' && j.state !== 'FINISHED') || typeof verdict !== 'string') return;
      // 「运行」也轮询同一个接口、返回同样的字段，只是 id 形如 runcode_…；只有数字 id 才是提交
      const submissionId = j.submission_id != null ? String(j.submission_id) : undefined;
      const isRun = submissionId != null && !/^\d+$/.test(submissionId);
      const request = isRun ? lastRun : lastSubmit;
      const slug = request?.slug ?? location.pathname.match(PROBLEM_RE)?.[1] ?? null;
      if (!slug) return;
      w.__acbLastJudge = judgeRecord(isRun ? 'run' : 'submit', { ...request, slug }, j);
      if (isRun) return;
      emit({
        slug,
        result: verdict === 'Accepted' ? 'pass' : 'fail',
        verdict,
        language: lastSubmit?.lang,
        submissionId,
      });
    };

    // 记下最近一次提交、运行请求里的语言和代码（运行还有测试输入），判题结果回来时用
    const remember = (url: string, body: unknown): 'submit' | 'run' | undefined => {
      const m = ENQUEUE_RE.exec(url);
      if (!m) return undefined;
      let data: Record<string, unknown> = {};
      try {
        const parsed = typeof body === 'string' ? JSON.parse(body) : null;
        if (parsed && typeof parsed === 'object') data = parsed;
      } catch {
      }
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
      const request = { slug: m[1]!, lang: text(data.lang), code: text(data.typed_code), input: text(data.data_input) };
      if (m[2] === 'submit') {
        lastSubmit = request;
        return 'submit';
      }
      lastRun = request;
      return 'run';
    };

    const origFetch = window.fetch.bind(window);
    window.fetch = async (input: any, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const action = typeof url === 'string' ? remember(url, init?.body) : undefined;
      let res = await origFetch(input, init);
      const resendable = (typeof input === 'string' || input instanceof URL) && typeof init?.body === 'string';
      if (action && resendable && res.status === 429) {
        res = await retryThrottled(action, res, () => origFetch(input, init));
      }
      if (typeof url === 'string' && JUDGE_RE.test(url)) {
        void res
          .clone()
          .text()
          .then((t) => inspect(url, t))
          .catch(() => {});
      }
      return res;
    };

    const xhrOpen = XMLHttpRequest.prototype.open as any;
    XMLHttpRequest.prototype.open = function (this: any, ...args: any[]) {
      this.__acbUrl = String(args[1]);
      return xhrOpen.apply(this, args as any);
    } as any;
    const xhrSend = XMLHttpRequest.prototype.send as any;
    XMLHttpRequest.prototype.send = function (this: any, body?: any) {
      const url: string = this.__acbUrl ?? '';
      remember(url, body);
      this.addEventListener('load', () => {
        try {
          inspect(url, this.responseText);
        } catch {
        }
      });
      return xhrSend.apply(this, [body] as any);
    } as any;
  },
});
