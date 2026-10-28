# acbuddy-extension

ACBuddy 的浏览器插件：**WXT + React + TypeScript + Manifest V3 + Side Panel**。
用户在力扣刷题时自动记录每次作答（结果/耗时/语言/提交 id）并收集心得，与
ACBuddy 网站同步。

## 目录结构

```
extension/
├── package.json                  # dev: wxt（watch 构建到 .output/chrome-mv3-dev）
├── wxt.config.ts                 # webExt.disabled=true（WXT 只构建，不自启浏览器）
├── public/_locales/zh_CN/        # 扩展名称和简介（manifest 引用 __MSG_extName__、__MSG_extDescription__）
├── tsconfig.json                 # 继承 .wxt/tsconfig.json
├── entrypoints/
│   ├── background.ts             # service worker：消息转发 + 计时（storage.session）+ 自动上报/心得补写
│   ├── content.ts                # content script（隔离世界）：读题、换题观察、提交结果心得卡
│   ├── leetcode-hook.content.ts  # content script（MAIN world）：包住 fetch/XHR 截获力扣判题结果
│   ├── lib/api.ts                # ACBuddy API client（面板与 background 共用）
│   └── sidepanel/                # Side Panel（登录态/题目/计时/进度与 AI 聊天）
│       ├── index.html
│       ├── main.tsx
│       └── App.tsx
├── tools/                        # 自动化测试驱动（MCP stdio 客户端）
│   ├── mcp-client.mjs            # chrome-devtools-mcp 的 MCP JSON-RPC 客户端
│   ├── test-auto-record.mjs      # ACBuddy 全链路 e2e（真实提交 AC + WA）
│   └── test-login-guide.mjs      # 登录引导回归
├── .chrome-profile/              # Chrome 独立开发 Profile（chrome-devtools-mcp --user-data-dir，勿提交）
└── .mcp-artifacts/               # 每轮测试的 snapshot/console 证据（勿提交）
```

## 消息链路

Side Panel 挂载或切换标签页时自动同步 →
`chrome.runtime.sendMessage` → background service worker（查询 active tab）
→ `chrome.tabs.sendMessage` → content script 解析当前页面：URL slug（支持
`/problems/<slug>/…` 与 `/contest/<name>/problems/<slug>/`）+ 页面 `__NEXT_DATA__`
里的 dehydrated GraphQL 数据（标题/中文标题/难度/questionId）+ DOM 兜底，返回：

```json
{ "ok": true, "isProblemPage": true, "slug": "two-sum",
  "title": "Two Sum", "translatedTitle": "两数之和",
  "difficulty": "Easy", "difficultyCn": "简单",
  "questionId": "1", "source": "next-data" }
```

已实测可读取的 leetcode.cn URL 形态：`/problems/<slug>/`、`/problems/<slug>/description/`、
`/problems/<slug>/solutions/`、`/problems/<slug>/submissions/`（未登录也能取到题目信息；
登录后可继续扩展 tags、提交记录等）。注意：`/editorial/` 未登录会被重定向。

## ACBuddy 集成（v0）

对接网站 https://acbuddy.pages.dev（接口以工作区 `functions/api/[[route]].ts` 为准）：

- 支持力扣国内版（leetcode.cn）和国际版（leetcode.com）：两边是同一套题，同一道题在网站上共用进度，
  每条作答记下提交站点（background 按发消息的标签页地址判断，不信消息内容）。
- `wxt.config.ts` 声明 `host_permissions: ["https://acbuddy.pages.dev/*"]`，
  fetch 带 `credentials: 'include'` 自动携带网站的 `acb_session`
  Cookie，无需任何密钥。
- **交互模型：全自动，无手动上报按钮**。用户在力扣点「提交」后：
  1. MAIN world 钩子（`entrypoints/leetcode-hook.content.ts`，包住页面
     fetch/XHR）截获判题轮询响应（`state === 'SUCCESS'` + `status_msg`，
     `Accepted` = 通过，其余——包括编译出错——都记为未通过；「运行」走同一个轮询接口，
     但 id 是 `runcode_…`，钩子只认数字 id，所以运行不会记录），顺带从提交
     请求体抓提交语言；通过 `window.postMessage`（source `acb-leetcode-hook`）
     交给隔离世界的 content script。白天力扣常对「提交」「运行」限流（入队请求回 429，
     页面提示「提交过于频繁」）：钩子原样重发，先每 1 秒 3 次，再每 2 秒 5 次、每 3 秒 5 次
     （共 28 秒），期间工具栏下方提示「正在自动重试」，页面只是多等一会儿；仍被拒才交还页面照常提示。
  2. background（`storage.session` 里**按题目**保存计时，面板没开也在走）自动
     `POST /api/attempts`（含站点/slug/结果/判题结果/耗时/语言/submissionId/标题/难度），直接使用响应中的作答 id。
     计时只累计「页面在前台、并且人在做题」的时间：
     - content script 在页面可见时每 15 秒发一次心跳，相邻心跳间隔超过 60 秒（切走、休眠）不计入，
       所以多标签页来回切不会把耗时清零。
     - 心跳带上最近一次操作的时间（键鼠、滚轮、切回页面；侧边栏里的操作也算）。连续 5 分钟
       （固定值，不提供设置）没有操作就自动暂停，并且这 5 分钟也不计入；
       5 分钟内回来，中间停下来想题的时间照常计入。打开题目页后一直没操作同样不算，从第一次操作开始。
     - 侧边栏计时旁可以手动暂停；点继续、或在编辑器里打字时自动恢复。暂停时可以从 0 重新计时。
     - 提交后清零：未通过马上开始下一次；通过则停止（看题解不算），在编辑器里改代码或点开始才重新计时。
  3. 页面右上角弹出心得卡（通过 ✓/未通过 ✗ + 心得框 + 记录状态 + 保存；× 或 Esc 跳过；
     底部细条显示 **5 秒自动消失**的倒计时，点击**或打字**都会取消倒计时）：保存 → `PUT /api/attempts/:id`
     补写该次心得。空心得直接视为跳过，题目当前笔记不受影响。
  4. Side Panel 顶部两行：题目与难度（右侧是对话记录 / 新建对话 / 设置按钮），下面是计时
     （从 background 读取，带暂停 / 继续按钮，悬停说明为什么停着）与进度汇总；未登录时这一行换成登录提示，账号显示在「设置」里。
     记录结果、心得保存以几秒后自动消失的提示呈现；通过 `ATTEMPT_REPORTED`/`NOTE_SAVED`/
     `PROBLEM_CHANGED` / `TIMER_STATE` 广播自动刷新。content script 在页面**可见时**每秒观察 URL
     换题（含 SPA 换题），页面不可见就停掉轮询和心跳。
- API client：`entrypoints/lib/api.ts`（面板与 background 共用）。

登录态获取/验证：`node tools/site-login.mjs`（在测试 Profile 里注册一个一次性账号
并验证 `GET /api/auth/me`；`--check-only` 只做持久化检查）。**凭据不写进代码**：
优先读 `ACB_TEST_USERNAME` / `ACB_TEST_PASSWORD` 环境变量，否则复用
`.mcp-artifacts/site-account.json`（gitignored），都没有就现场随机生成。

端到端测试：**先起 `npm run dev` watcher 再跑**（dev 构建的模块由 dev server
供给，没有 watcher 时面板和 content script 都不会工作）。流程：`node
tools/test-auto-record.mjs` —— 打开 two-sum → 开 Side Panel → 自动读题/登录态断言
→ Monaco 填入 AC 代码并点「提交」（真实判题，覆盖钩子→content→background→API
全链路）→ 断言面板自动记录、心得卡出现 → 卡片里填心得保存 → 服务器两侧验证
（`GET /api/progress/two-sum` 的 attemptCount/result/note/language）
→ 再真实提交一次答案错误代码（真实 Wrong Answer → 未通过自动记录）→
控制台干净度检查。

**注意**：改 `wxt.config.ts` 后 WXT dev watch 不会自动重载配置，需要重启
`npm run dev`（entrypoints 源码变更则会自动重建）。

## AI 编程助手

侧边栏提供聊天输入框，可以询问题目思路、完整答案、代码错误和历次作答心得。
实现参考 [learn-claude-code 的工具调用循环](https://github.com/shareAI-lab/learn-claude-code/blob/main/agents/s02_tool_use.py)：
请求模型 → 执行模型选择的工具 → 返回工具结果 → 继续请求模型，直到模型给出回答。
模型循环直接运行于侧边栏，使用浏览器 `fetch`。聊天界面使用
[assistant-ui](https://github.com/assistant-ui/assistant-ui)，通过 `ExternalStoreRuntime` 接入现有 Agent 和本机对话记录。
消息区支持 Markdown 标题、列表、引用、表格、行内代码及代码块高亮，提供代码与回答复制、自动滚动和回到最新消息。
中文标点紧挨着加粗、斜体标记时（如 `**复杂度：**时间`），CommonMark 默认不识别，消息区用 [remark-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly) 放宽这条规则。
LaTeX 公式使用 KaTeX 在本机渲染：行内公式写作 `$O(n \log n)$`，独立公式使用上下两行 `$$` 包围公式内容。
支持分数、求和、上下标、根式和矩阵等常用数学表达式，公式字体随插件打包。
工具调用以可展开的状态卡展示执行结果，输入框固定在面板底部，支持发送和停止回答；空对话提供「思路提示 / 检查我的代码 / 完整题解」快捷提问。
题目或对话尚未就绪、或尚未配置模型时可以先输入草稿，输入框上方用一行说明暂时无法发送的原因；对话加载完成后保留已输入的内容。

### 配置与使用

1. 构建或启动开发插件，在 Chrome 扩展管理页面重新加载扩展，以应用新增权限。
2. 打开力扣题目和插件侧边栏，点击右上角的「设置」。
3. 选择接口类型，填写 API 基础地址（例如服务提供的 `/v1` 地址）、模型名称和 API Key，保存时允许访问该服务。
   默认使用 Responses API，在基础地址后添加 `/responses`；也可以选择 Chat Completions，使用 `/chat/completions`。
   地址可以填写基础地址或对应的完整接口地址。模型服务需要支持所选接口的自定义函数工具调用。
   HTTPS 服务和 localhost / 127.0.0.1 的 HTTP 服务均可使用。
4. 直接提问，例如「根据我的代码分析错误，并高亮有问题的行」或「给出完整答案并解释复杂度」。
   Enter 发送，Shift + Enter 换行，可以停止回答；右上角按钮可以新建对话或打开对话记录切换、删除对话（删除需再点一次确认）。

| 工具 | 内容 |
| --- | --- |
| `get_code` | 当前 Monaco 编辑器中的完整代码及语言 |
| `get_history` | 本站当前题目的最近 20 条提交结果、语言、时间、心得及当前笔记，需要网站登录；历史源代码尚未保存在本站 |
| `highlight_errors` | 按读取代码的行号显示整行背景、错误标记和错误说明 |
| `clear_highlights` | 清除助手添加的错误标记 |

高亮前检查题目、编辑器模型和代码快照。代码修改后自动清除助手标记。
新对话打开时自动读取一次完整题干、示例和约束，保存为对话开头的题目信息。
后续提问和重新打开面板时复用这份信息；每个新建对话各自加载一次题目。
题目信息加载失败时可以重试，加载成功后才能提问。模型通过对话开头获取题目，工具列表提供代码、历史和高亮操作。
每次提问绑定标签页和题目，切换标签页或页面导航时停止本次回答。
对话记录按题目分组（当前题目在最前），每道题可以有多个对话。标题自动使用首次提问的内容。
对话使用独立编号保存在 `chrome.storage.local`，关闭面板或重启浏览器后仍然保留，同一道题的不同标签页共用对话列表。
第一次打开题目时自动新建对话；再次进入时自动打开该题最近更新的对话，手动查看较早对话不会改变这个顺序。
对话记录也可以查看其他题目的历史，输入框上方提供「打开题目」，打开对应题目后可以继续提问。
新建或切换对话会停止正在进行的回答，已完成的消息保留在原对话。删除对话会同时移除列表条目和消息记录。
密钥使用 `chrome.storage.local` 保存在本机，并限制为插件可信页面访问。
题目、代码、心得和对话在提问时按模型的工具请求发送到配置的服务。
插件不会自动修改代码或提交答案。

每次提问最多 12 次模型请求、24 次工具调用；模型请求超时 90 秒，题干与历史读取超时 15 秒。
题干最多读取 40000 个字符，代码超过 80000 个字符时会提示缩短；
历史中的当前笔记最多读取 12000 个字符，每条心得最多读取 4000 个字符。
模型连接失败、格式无效和工具执行失败会显示说明，停止时保留已完成的对话。
当前使用已有网站接口，接口以 `functions/api/[[route]].ts` 为准。

Responses 使用 `input` / `output` 传递消息，以 `call_id` 关联 `function_call` 与 `function_call_output`。
请求设置 `store: false`，完整保存并在后续请求中回传输出项（包括加密推理项）。
切换接口类型时，按所选接口生成消息格式；Chat Completions 请求会省略 Responses 专用字段。

## GitHub Actions 打包

推送 `extension/` 或工作流文件的修改后，GitHub Actions 会运行
`Build extension ZIP`：安装锁定依赖、检查类型、构建生产插件并生成 ZIP。
在对应运行页面的 **Artifacts** 中下载 `acbuddy-extension-chrome.zip`。
ZIP 根目录包含 `manifest.json`，解压后可以在 Chrome 扩展管理页面选择「加载已解压的扩展程序」。
工作流也支持 `workflow_dispatch` 手动触发。

## 命令

```bash
npm install        # 安装依赖（postinstall 会跑 wxt prepare 生成 .wxt 类型）
npm run dev        # watch 构建 .output/chrome-mv3-dev（不自启浏览器）
npm run build      # 生产构建
npm run zip        # 生产构建并打包 ZIP，Chrome 和 Edge 共用
```

## 自动化测试（Chrome DevTools MCP）

跑 e2e 前先 `npm run dev`（见上文注意事项），然后：

```bash
node tools/test-auto-record.mjs    # ACBuddy 全链路 e2e（真实提交 AC + WA）
node tools/test-auto-record.mjs --site=leetcode.com   # 同上，在力扣国际版提交（profile 需登录 leetcode.com）
node tools/test-login-guide.mjs    # 登录引导回归
```

其他手动驱动工具：

```bash
node tools/test-leetcode.mjs   # leetcode.cn 多种 URL 形态的题目信息提取
node tools/test-panel-info.mjs # Side Panel 自动读取题目信息检查
node tools/open-profile.mjs    # 用开发 Profile 手动开 Chrome（登录 leetcode.cn 用）
```

所有测试脚本都会 install_extension → **reload_extension（必须！）**，且会强制结束
占用 `.chrome-profile` 的 Chrome 进程后独占该 profile。

**已知大坑（重要）**：Profile 是持久化的，而 unpacked 扩展的 id 由绝对路径派生、每次安装都相同，
Chrome 会把 service worker 脚本按 URL 缓存——**扩展源码更新后，`install_extension` 装进去的
SW 可能仍是缓存里的旧代码**（表现为新加的消息分支收不到、端口立即关闭 "The message port closed
before a response was received"）。因此所有测试脚本在 install 之后都会强制 `reload_extension`。
同理，手动改完源码后也需要 `reload_extension`（或让 WXT dev 的自动 reload 触发）。

## 登录态保留

`.chrome-profile` 是持久化 Profile（非临时目录），Cookie/登录态跨浏览器重启保留；
unpacked 扩展本身不跨重启（每次会话重装即可，不影响登录态）。

给扩展的浏览器登录 leetcode.cn：`node tools/open-profile.mjs`（或手动用
`--user-data-dir=<项目>\.chrome-profile` 启动 Chrome），登录完成后关窗口即可。
注意：自动化测试启动前会强制结束占用该 Profile 的 Chrome 进程，请先关闭手动窗口再跑测试。

## ZCode MCP 配置（用户级 `~/.zcode/cli/config.json`）

```json
{
  "mcp": {
    "servers": {
      "chrome-devtools": {
        "command": "node",
        "args": [
          "/path/to/acbuddy/extension/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
          "--user-data-dir=/path/to/acbuddy/extension/.chrome-profile",
          "--workspace=/path/to/acbuddy/extension",
          "--experimentalIncludeAllPages=true",
          "--categoryExtensions=true"
        ]
      }
    }
  }
}
```

要点：

- `--categoryExtensions` 才有 install_extension / reload_extension / trigger_extension_action 等扩展工具；
  该类别目前只支持 MCP 自己启动 Chrome（pipe 连接），不支持 browserUrl/wsEndpoint。
- `--user-data-dir` 指向项目内 `.chrome-profile`，与日常 Chrome Profile 完全隔离。
- `--experimentalIncludeAllPages` 让 list_pages 额外列出 Extension Service Worker（`sw-1`）与 Side Panel 页。
- `--workspace` 放行 install_extension 读取 `.output/chrome-mv3-dev`（默认只允许临时目录）。
