import { useEffect, useState, type ReactNode } from "react";

const CHROME_STORE_URL = "https://chromewebstore.google.com/detail/acbuddy/hkjijhnnjghgndikpiaaeanilgpjfhfk";
const GITHUB_URL = "https://github.com/Windyskr/acbuddy";
const DOWNLOAD_URL = `${GITHUB_URL}/actions/workflows/extension-zip.yml?query=branch%3Amain+is%3Asuccess`;

// 按钮名照抄浏览器中文界面（Chrome 155、Edge 156），浏览器改版后要跟着改
const BROWSERS = {
  chrome: { name: "Chrome", address: "chrome://extensions/", devMode: "开发者模式", loadLabel: "加载未打包的扩展程序" },
  edge: { name: "Edge", address: "edge://extensions/", devMode: "开发人员模式", loadLabel: "加载解压缩的扩展" },
};
type Browser = keyof typeof BROWSERS;

const IS_EDGE = navigator.userAgent.includes("Edg/");
const LINK_CLASS = "font-medium text-blue-600 underline decoration-blue-200 underline-offset-4 hover:text-blue-700";
const CODE_CLASS = "rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700";

function Step({ number, done = false, title, children }: { number: number; done?: boolean; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 p-5 sm:gap-4 sm:px-6">
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}
      >
        {done ? "✓" : number}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="pt-0.5 font-semibold text-slate-800">{title}</h3>
        <div className="mt-1.5 space-y-3 text-sm leading-7 text-slate-600">{children}</div>
      </div>
    </li>
  );
}

export default function InstallGuide({ authed, onLogin }: { authed: boolean; onLogin: () => void }) {
  const [browser, setBrowser] = useState<Browser>(IS_EDGE ? "edge" : "chrome");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const selected = BROWSERS[browser];

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "安装浏览器插件 · ACBuddy";
    return () => { document.title = previousTitle; };
  }, []);

  useEffect(() => {
    if (copyStatus !== "copied") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 3000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(selected.address);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8" aria-labelledby="install-title">
        <img src="/favicon.png" alt="" className="h-12 w-12" />
        <h1 id="install-title" className="mt-5 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">安装 ACBuddy 浏览器插件</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600 sm:text-base">
          在力扣国内版和国际版提交后，自动记录结果和用时，随手写下心得，进度同步到题目列表。
        </p>
        <a
          href={CHROME_STORE_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          从 Chrome 应用商店安装 <span aria-hidden="true">↗</span>
        </a>
        {IS_EDGE && (
          <p className="mt-3 text-sm leading-6 text-slate-500">Edge 打开商店页面后，先点顶部提示里的「允许来自其他商店的扩展」，再点「添加至 Chrome」。</p>
        )}
        <p className="mt-4 text-xs leading-6 text-slate-400">支持电脑端 Chrome 116 及以上版本和 Edge</p>
      </section>

      <details className="group mt-4 rounded-2xl border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-5 py-4 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:px-6 [&::-webkit-details-marker]:hidden">
          无法访问 Chrome 应用商店？手动安装
          <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden="true">
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </summary>
        <ol className="divide-y divide-slate-100 border-t border-slate-100">
          <Step number={1} title="下载安装包">
            <p>
              登录 GitHub 后打开{" "}
              <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>Build extension ZIP</a>
              ，点开最上面的一次构建，在页面底部的 Artifacts 里下载 <code className={CODE_CLASS}>acbuddy-extension-chrome.zip</code>。
            </p>
          </Step>
          <Step number={2} title="解压到固定位置">
            <p>解压到一个不会删除的文件夹，浏览器会一直从这里读取插件。打开文件夹应该能直接看到 <code className={CODE_CLASS}>manifest.json</code>，看不到就再进一层。</p>
          </Step>
          <Step number={3} title="在浏览器中加载">
            <div role="group" aria-label="选择浏览器" className="inline-flex gap-1 rounded-lg bg-slate-100 p-1">
              {(Object.keys(BROWSERS) as Browser[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={browser === key}
                  onClick={() => { setBrowser(key); setCopyStatus("idle"); }}
                  className={`rounded-md px-4 py-1 text-sm font-medium transition-colors ${browser === key ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                >
                  {BROWSERS[key].name}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <code className="select-all break-all text-xs text-slate-700 sm:text-sm">{selected.address}</code>
              <button
                type="button"
                onClick={() => void copyAddress()}
                aria-live="polite"
                className="shrink-0 rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-blue-200 hover:text-blue-600"
              >
                {copyStatus === "copied" ? "已复制" : copyStatus === "failed" ? "复制失败，请手动复制" : "复制地址"}
              </button>
            </div>
            <p>把地址粘贴到地址栏打开，开启「{selected.devMode}」，点「{selected.loadLabel}」，选择上一步的文件夹。</p>
          </Step>
        </ol>
        <p className="border-t border-slate-100 px-5 py-4 text-xs leading-6 text-slate-500 sm:px-6">
          手动安装的插件不会自动更新：下载新安装包覆盖文件夹里的文件，在扩展管理页点 ACBuddy 的「重新加载」，再刷新力扣页面。GitHub 上的安装包只保留 30 天，找不到时请
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" className={LINK_CLASS}>反馈问题</a>。
        </p>
      </details>

      <h2 className="mt-9 text-lg font-semibold text-slate-800">开始使用</h2>
      <ol className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
        <Step number={1} done={authed} title="登录 ACBuddy">
          <p>{authed ? "你已登录，插件会自动同步这个浏览器里的登录状态。" : "在装插件的浏览器里登录，插件会自动同步登录状态，不用另外登录。"}</p>
          {!authed && (
            <button type="button" onClick={onLogin} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">
              登录或注册
            </button>
          )}
        </Step>
        <Step number={2} title="打开力扣题目">
          <p>打开任意一道力扣题目（装插件前就开着的页面要先刷新）。提交后会自动记下结果和用时，并弹出心得卡，可以随手写下思路。</p>
        </Step>
        <Step number={3} title="打开侧边栏">
          <p>点工具栏上的 ACBuddy 图标打开侧边栏，查看计时和作答记录，也可以请 AI 辅导。新装的插件收在拼图形状的扩展菜单里，可以固定到工具栏。</p>
        </Step>
      </ol>

      <footer className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-slate-400">
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-slate-600 hover:underline">GitHub</a>
        <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" className="hover:text-slate-600 hover:underline">反馈问题</a>
        <a href="/privacy.html" target="_blank" rel="noreferrer" className="hover:text-slate-600 hover:underline">隐私政策</a>
      </footer>
    </main>
  );
}
