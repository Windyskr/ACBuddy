import { useEffect, useState, type ReactNode } from "react";

const GITHUB_URL = "https://github.com/Windyskr/acbuddy";
const DOWNLOAD_URL = `${GITHUB_URL}/actions/workflows/extension-zip.yml?query=branch%3Amain+is%3Asuccess`;

const BROWSERS = {
  chrome: { name: "Chrome", address: "chrome://extensions/", loadLabel: "加载已解压的扩展程序" },
  edge: { name: "Edge", address: "edge://extensions/", loadLabel: "加载解压缩的扩展" },
};

function InstallStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 p-5 sm:gap-4 sm:p-6">
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-blue-600">
        {number}
      </span>
      <section className="min-w-0 flex-1">
        <h3 className="pt-0.5 text-base font-semibold text-slate-800">{title}</h3>
        <div className="mt-2 space-y-3 text-sm leading-7 text-slate-600">{children}</div>
      </section>
    </li>
  );
}

export default function InstallGuide({ authed, onLogin }: { authed: boolean; onLogin: () => void }) {
  const [browser, setBrowser] = useState<keyof typeof BROWSERS>(() => navigator.userAgent.includes("Edg/") ? "edge" : "chrome");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const selectedBrowser = BROWSERS[browser];

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
      await navigator.clipboard.writeText(selectedBrowser.address);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <a href="/" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-blue-600">
        <span aria-hidden="true">←</span> 返回题目列表
      </a>

      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8" aria-labelledby="install-title">
        <div className="flex flex-wrap items-center gap-3">
          <img src="/favicon.png" alt="" className="h-12 w-12" />
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">Chrome · Edge 浏览器插件</span>
        </div>
        <h1 id="install-title" className="mt-5 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">安装 ACBuddy 浏览器插件</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600 sm:text-base">
          安装 ACBuddy，在力扣国内版与国际版自动记录作答结果和用时，随时回顾进度与心得。
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-500">插件暂未上架应用商店，请通过 GitHub 下载安装包，按照下面的步骤完成安装。</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a
            href={DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            前往 GitHub 下载安装包 <span aria-hidden="true">↗</span>
          </a>
          <a href="#install-steps" className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-800">查看安装步骤 <span aria-hidden="true">↓</span></a>
        </div>
        <p className="mt-4 text-xs leading-6 text-slate-400">请在电脑端安装 · Chrome 116 及以上版本，或 Edge · 下载需要登录 GitHub</p>
      </section>

      <h2 id="install-steps" className="mt-9 scroll-mt-20 text-lg font-semibold text-slate-800">安装步骤</h2>
      <ol className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
        <InstallStep number={1} title="从 GitHub 下载安装包">
          <p>
            登录 GitHub，打开{" "}
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer" className="font-medium text-blue-600 underline decoration-blue-200 underline-offset-4 hover:text-blue-700">Build extension ZIP</a>
            {" "}页面，选择 main 分支上最近一次带有绿色勾选标记的成功构建。
          </p>
          <p>在构建详情页面底部找到 <strong className="font-medium text-slate-800">Artifacts</strong>，点击下载下面的文件：</p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs break-all text-slate-700">acbuddy-extension-chrome.zip</div>
        </InstallStep>

        <InstallStep number={2} title="解压并保留插件文件夹">
          <p>将 ZIP 安装包解压到一个固定文件夹，确认文件夹中包含 <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">manifest.json</code> 文件。下一步需要选择这个文件夹。</p>
          <p className="text-slate-500">安装后请保留这个文件夹，浏览器会持续从这里读取插件文件。</p>
        </InstallStep>

        <InstallStep number={3} title="在浏览器中加载插件">
          <div role="group" aria-label="选择安装插件的浏览器" className="inline-flex gap-1 rounded-lg bg-slate-100 p-1">
            {(Object.keys(BROWSERS) as Array<keyof typeof BROWSERS>).map((key) => (
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
            <code className="select-all break-all text-xs text-slate-700 sm:text-sm">{selectedBrowser.address}</code>
            <button type="button" onClick={() => void copyAddress()} className="shrink-0 rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-blue-200 hover:text-blue-600">
              {copyStatus === "copied" ? "已复制" : "复制地址"}
            </button>
          </div>
          <p role="status" className={`text-xs leading-6 ${copyStatus === "failed" ? "text-amber-700" : "text-slate-500"}`}>
            {copyStatus === "copied" ? "地址已复制，请粘贴到浏览器地址栏并打开。" : copyStatus === "failed" ? "复制失败，请手动选中上面的地址，复制到浏览器地址栏并打开。" : "将上面的地址粘贴到浏览器地址栏并打开。"}
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>开启扩展管理页面中的「开发者模式」。</li>
            <li>点击「{selectedBrowser.loadLabel}」，选择上一步解压后包含 manifest.json 的文件夹。</li>
            <li>看到 ACBuddy 出现在扩展列表中，即表示安装完成。</li>
          </ol>
        </InstallStep>

        <InstallStep number={4} title="登录 ACBuddy，开始刷题">
          <p>{authed ? "你已登录 ACBuddy，插件会自动同步当前浏览器中的登录状态。" : "在安装插件的同一个浏览器中登录 ACBuddy，插件会自动同步登录状态。"}</p>
          <p>刷新已经打开的力扣题目页面，从浏览器的扩展菜单中点击 ACBuddy，打开侧边栏。之后每次提交的结果和用时都会自动记录，也可以填写当次作答的心得。</p>
          {authed ? (
            <a href="/" className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-3 py-1.5 font-medium text-blue-600 hover:bg-blue-100">返回题目列表 <span aria-hidden="true">→</span></a>
          ) : (
            <button type="button" onClick={onLogin} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">登录 ACBuddy</button>
          )}
        </InstallStep>
      </ol>

      <section className="mt-9" aria-labelledby="install-faq">
        <h2 id="install-faq" className="text-lg font-semibold text-slate-800">常见问题</h2>
        <div className="mt-4 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white px-5 sm:px-6">
          <details className="py-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">GitHub 页面中无法下载安装包？</summary>
            <p className="mt-3 text-sm leading-7 text-slate-500">请先登录 GitHub，再进入最近一次成功构建的详情页面，查看底部的 Artifacts。安装包保留 30 天；如果已经过期，可以通过下方的「反馈问题」联系维护者。</p>
          </details>
          <details className="py-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">加载时提示找不到 manifest.json？</summary>
            <p className="mt-3 text-sm leading-7 text-slate-500">请先完成解压，并选择直接包含 manifest.json 的文件夹。如果解压后还有一层文件夹，请进入其中查找该文件。</p>
          </details>
          <details className="py-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">如何更新已经安装的插件？</summary>
            <p className="mt-3 text-sm leading-7 text-slate-500">下载新的安装包并解压，用新版文件覆盖原插件文件夹中的内容，然后在浏览器扩展管理页面点击 ACBuddy 的「重新加载」，最后刷新力扣题目页面。</p>
          </details>
        </div>
      </section>

      <footer className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-slate-400">
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-slate-600 hover:underline">GitHub</a>
        <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" className="hover:text-slate-600 hover:underline">反馈问题</a>
        <a href="/privacy.html" target="_blank" rel="noreferrer" className="hover:text-slate-600 hover:underline">隐私政策</a>
      </footer>
    </main>
  );
}
