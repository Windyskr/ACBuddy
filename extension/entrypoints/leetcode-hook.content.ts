export default defineContentScript({
  matches: ['https://leetcode.cn/*', 'https://leetcode.com/*'],
  world: 'MAIN',
  main() {
    const w = window as unknown as Record<string, unknown>;
    if (w.__acbHookInstalled) return;
    w.__acbHookInstalled = true;

    const PROBLEM_RE = /\/problems\/([a-z0-9-]+)/;
    const SUBMIT_RE = /\/problems\/([a-z0-9-]+)\/submit\/?(\?|$)/;
    const JUDGE_RE = /check|submission/i;
    // 力扣限流时入队请求回 429（空 body、无 Retry-After），服务端没有建任务，原样重发是安全的
    const ENQUEUE_RE = /\/problems\/[a-z0-9-]+\/(submit|interpret_solution)\/?(\?|$)/;
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

    let lastSubmit: { slug: string; lang?: string } | null = null;

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
      let j: { state?: string; status_msg?: string; submission_id?: number | string };
      try {
        j = JSON.parse(text);
      } catch {
        return;
      }
      // 力扣判题完成时 state 为 "SUCCESS"；兼容 "FINISHED" 以防接口变动
      if ((j.state !== 'SUCCESS' && j.state !== 'FINISHED') || typeof j.status_msg !== 'string') return;
      // 「运行」也轮询同一个接口、返回同样的字段，只是 id 形如 runcode_…；只有数字 id 才是提交
      const submissionId = j.submission_id != null ? String(j.submission_id) : undefined;
      if (submissionId && !/^\d+$/.test(submissionId)) return;
      const slug = lastSubmit?.slug ?? location.pathname.match(PROBLEM_RE)?.[1] ?? null;
      if (!slug) return;
      emit({
        slug,
        result: j.status_msg === 'Accepted' ? 'pass' : 'fail',
        verdict: j.status_msg,
        language: lastSubmit?.lang,
        submissionId,
      });
    };

    const langFromBody = (body: unknown): string | undefined => {
      if (typeof body !== 'string') return undefined;
      try {
        const lang = JSON.parse(body).lang;
        return typeof lang === 'string' ? lang : undefined;
      } catch {
        return undefined;
      }
    };

    const origFetch = window.fetch.bind(window);
    window.fetch = async (input: any, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const sm = typeof url === 'string' ? url.match(SUBMIT_RE) : null;
      if (sm?.[1]) lastSubmit = { slug: sm[1], lang: langFromBody(init?.body) };
      let res = await origFetch(input, init);
      const enqueue = (typeof input === 'string' || input instanceof URL) && typeof init?.body === 'string'
        ? ENQUEUE_RE.exec(url)?.[1] : undefined;
      if (enqueue && res.status === 429) {
        res = await retryThrottled(enqueue === 'submit' ? 'submit' : 'run', res, () => origFetch(input, init));
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
      const sm = url.match(SUBMIT_RE);
      if (sm?.[1]) lastSubmit = { slug: sm[1], lang: langFromBody(body) };
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
