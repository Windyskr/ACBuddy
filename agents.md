# agents.md —— AI / 自动化代理开发约定

> 本文件是给所有参与本项目的 AI 代理和自动化流程的约定。改动项目前必读。

## 项目阶段声明

**本项目自 2026-09-12 起处于开发阶段：**

- ✅ **允许破坏性更新**：数据库 schema、API 契约、数据格式、目录结构都可以随时推翻重做
- ✅ **不保存既往数据**：不需要写迁移兼容逻辑、不需要数据保留、不需要向后兼容。改坏了解决办法就是删库重建
- ❌ 不要为"兼容旧数据"编写任何代码，不要犹豫是否该删数据

## 数据库约定（Cloudflare D1）

- 数据库：`acbuddy-db`，绑定名 `DB`（wrangler.jsonc）
- 迁移由 `scripts/db-migrate.mjs` 统一执行，`schema_migrations` 表记录已执行的文件名，重复跑是空操作：
  - `npm run db:migrate:local` / `npm run db:migrate:remote` —— 按文件名顺序补齐所有未执行的迁移，**保留数据**
  - `npm run db:migrate:status` —— 查看账本
  - `npm run db:reset:local` —— 删表重建（只作用于本地；对 remote 需要显式 `--reset --force`）
- **加 schema 变更就新建一个编号文件**，不要回头改 `0001_init.sql`。`0001` 只负责「从零建表」，本身不含 DROP —— 一个 `--remote` 打错就删库的风险不该存在于文件里。
- 存量库若已是某个版本的 schema 但没有账本，用一次 `node scripts/db-migrate.mjs remote --baseline <到这个文件为止>` 补账本。
- 查看开发用户 api_key：`npm run db:key:local` / `npm run db:key:remote`
- 开发账号用 `npm run db:seed:local` 创建，密码随机生成且只打印一次（可用 `ACB_DEV_PASSWORD` 指定）。**任何凭据都不许写进代码或文档。**

## API 契约

- 接口以 `functions/api/[[route]].ts` 为准（Pages Functions，随 `npm run deploy` 一起部署），文件头写了认证、响应包络和字段语义，不另写接口文档
- **改动任何接口（路径、字段、语义）必须同步改两个调用方**：网站 `src/types.ts`、`src/lib/api.ts`，扩展 `extension/entrypoints/lib/api.ts`
- 题目用 `(platform, slug)` 标识，平台表在接口文件的 `PLATFORMS`，接新平台只加一项、不改表；作答记录另记提交站点 `site`。力扣国内版、国际版同属 `leetcode`：slug 相同、同一道题共用进度，`site` 区分 `leetcode.cn` / `leetcode.com`，提交 id 按站点去重（两站各自编号）
- 两种笔记互不同步：`progress.note` 是题目当前笔记，只由 `PUT /api/progress/:platform/:slug` 改；`attempts.note` 是每次作答的心得。不要再让任何写入路径把心得复制成当前笔记
- 本地调试：`npm run dev:api`（http://localhost:8788/api/*）

## Chrome 扩展（`extension/`）

- 已纳入本仓库版本控制（WXT + React + TS，Manifest V3 Side Panel）。可能由多个进程并行开发：动手前先拉最新代码，提交只圈定 `extension/` 内的文件
- 交互模型（**全自动，无手动上报按钮**）：用户在力扣（国内版 leetcode.cn、国际版 leetcode.com 都支持）点「提交」→ MAIN world 钩子（`entrypoints/leetcode-hook.content.ts`，包住页面 fetch/XHR）截获判题响应 → background 自动 `POST /api/attempts`（计时在 background 的 `storage.session` 里按题目累计，面板没开也在走：只算页面在前台且有操作的时间，5 分钟无操作自动暂停并扣掉这段（固定值，不提供设置），侧边栏可手动暂停，通过后停止、改代码才重新开始；规则写在 `background.ts` 文件头；提交语言从提交请求体抓）→ 页面右上角弹心得卡（5 秒内无点击自动消失），保存时 `PUT /api/attempts/:id` 补写该次心得，不改题目当前笔记。Side Panel 展示登录态、题目、计时和进度，并提供 AI 聊天及按题目分组的对话列表，随标签页切换与后台广播自动刷新
- 扩展与站点对接以 `functions/api/[[route]].ts` 为准；改接口时同步改网站与扩展的调用方（见上节）

### 开发与测试命令（在 `extension/` 下）

```bash
npm install                        # postinstall 跑 wxt prepare
npm run dev                        # watch 构建 .output/chrome-mv3-dev —— 跑 e2e 前必须开着
npm run compile                    # tsc --noEmit
npm run build                      # 生产构建 → .output/chrome-mv3
npm run zip                        # 生产构建并打包 → .output/acbuddy-extension-<版本>-chrome.zip
node tools/test-auto-record.mjs    # e2e：真实提交 AC + Wrong Answer 各一次，验证自动记录/心得卡/服务器侧
node tools/test-auto-record.mjs --site=leetcode.com   # 同上，在力扣国际版提交，并检查两站共用进度
node tools/test-login-guide.mjs    # e2e：登录引导回归
```

- e2e 依赖：项目内持久 profile `.chrome-profile/`（力扣国内版、国际版与 ACBuddy 测试号的登录态都在里面，勿提交、勿在测试外占用）；测试账号凭据在 `.mcp-artifacts/site-account.json`（gitignored）；测试会独占该 profile
- **`npm run dev` watcher 必须先起**：dev 构建的模块由 dev server 供给，没 watcher 时面板空白、content script 不运行（e2e 会假失败一片）

### 已踩实的坑（改扩展前必读）

- 用 chrome-devtools-mcp 装扩展后**必须紧跟 `reload_extension`**：SW 脚本按 URL 缓存，不 reload 跑的还是旧代码（表现为 "The message port closed..."）
- 力扣 `POST /problems/<slug>/submit/` 会**忽略 body 里的 typed_code、判编辑器草稿**——要真实提交必须往 Monaco 编辑器填码再点「提交」按钮（e2e 即此做法）
- 力扣判题完成时 check 响应的 `state === "SUCCESS"`（不是 FINISHED）；`status_msg` 除 `Accepted` 外（含编译出错）一律记为未通过
- 钩子→content→background 的消息必须透传 `submissionId`：页面判完常会再拉一次 check，丢了它后台去重失效就会双记
- 点提交有时整页跳到 `/problems/<slug>/submissions/<id>/`，判题在换页期间完成、详情页不再轮询——content script 对此有兜底检测（带 10 分钟新鲜度 + submissionId 去重，翻旧记录不误记）
- 「运行」也轮询 `/submissions/detail/<id>/check/`，返回同样的 `state`/`status_msg`，只是 id 为 `runcode_…`：钩子只认数字 id，否则每次运行都会弹卡
- 白天力扣常对「提交」「运行」限流：入队请求（`/submit/`、`/interpret_solution/`）回 429（空 body、无 `Retry-After`），页面只弹「提交过于频繁」就放弃。实测冷却：提交约 6 秒、运行约 10 秒。被拒时服务端没有建任务，钩子据此自动原样重发
- 力扣国际版与国内版的提交、运行、判题轮询接口路径和响应字段相同，钩子与详情页兜底两站共用；但提交 id 各自编号（国内版约 7.6 亿、国际版约 21.8 亿），记录和去重都要带站点。国际版 GraphQL 也接受 `translatedTitle` / `translatedContent`，只是返回 null，读题用同一条查询即可
- 力扣切换面板（运行时打开「测试结果」、切到题解/提交记录）会 `history.replaceState`，Chrome 因此发 `tabs.onUpdated`（`status: 'loading'`）：这不代表换题，要比较 slug 再决定是否停止回答、切换对话

### 插件修改后的验证流程（必须遵循）

修改插件代码后，按受影响功能执行下面的浏览器检查，并完成类型检查和生产构建。聊天界面、输入框或对话状态的修改必须包含真实浏览器交互；仅修改文档时检查文档和差异即可。

#### 1. 准备开发环境

- 在 `extension/` 下执行命令，沿用项目的 npm 和 `package-lock.json`；需要安装锁定依赖时使用 `npm ci`。
- 启动 `npm run dev`，等待开发构建完成，并记录实际开发服务地址。端口可能为 `3000` 或 `3001`，从日志或侧边栏脚本地址读取。
- 使用 `tools/mcp-client.mjs` 导出的 `McpClient`、`EXT_PATH`、`ARTIFACTS` 等现有工具驱动真实 Chrome。运行测试时独占 `.chrome-profile/`。
- 执行 `install_extension` 后立即执行 `reload_extension`，再打开题目和侧边栏。
- 在 WSL 挂载目录中，如果修改后浏览器仍运行旧模块，先重启本次启动的开发服务，再重新加载扩展，并确认开发服务返回的源码已经更新。
- 每次打开标签页、重新加载扩展或重新打开侧边栏后，通过 `list_pages` 重新确认页面编号。侧边栏页面可能被重新创建；页面编号、标签页编号和扩展编号均从实际返回值读取。

#### 2. 建立检查数据与模型响应

- 题目读取、编辑器访问、插件消息传递和浏览器存储使用实际实现。公共题目可以使用 `two-sum` 和 `3sum`，题目地址从项目题库或当前页面确认。
- 需要测试消息展示时，可以通过 `entrypoints/lib/agent-conversation.ts` 的现有方法创建临时对话并保存检查内容，再重新打开对话检查界面。
- 没有真实模型配置时，可以临时拦截侧边栏对 `https://agent-review.invalid/v1` 的模型请求，返回符合所选接口格式的模拟响应，继续执行真实 Agent 循环和真实工具。
- 模拟响应应包含工具调用及后续回答；验证工具调用编号、工具结果和后续模型请求正确关联。修改协议处理时同时检查 Responses 与 Chat Completions，Responses 还要检查推理项回传。
- 临时替换模型配置前保存原值，配置缺失也要记录。所有临时修改都必须能在 `finally` 中恢复。凭据不得打印到日志、截图、代码或文档。
- 报告验证结果时明确说明使用了模拟模型响应。真实模型的回答质量和服务连接需要实际调用才能确认。

#### 3. 执行受影响功能的浏览器检查

| 修改范围 | 必须检查的行为 |
| --- | --- |
| 输入框与发送状态 | 使用 MCP 的 `click`、`fill`、`press_key` 实际点击、输入及按下 Enter；检查 `document.activeElement`、输入值、`disabled` 和发送按钮状态。覆盖题目未打开、对话正在加载和正常就绪的情况。无法发送时仍可输入草稿；加载完成后草稿与光标保留；缺少模型配置时显示原因并保留草稿 |
| 对话与题目上下文 | 首次进入题目创建对话，再次进入打开该题最近更新的对话。同题多个对话独立保存，不同题目正确分组；查看较早对话不会改变更新时间；继续提问后更新排序。新对话完整读取题目一次，后续提问和恢复对话的完整题目读取次数为零 |
| 保存、恢复和删除 | 重新打开侧边栏及重新启动浏览器后恢复列表和消息；同题不同标签页共用记录；删除后移除列表条目和消息，正确选择后续对话；已删除对话不能被延迟保存操作重新创建 |
| 停止与切换 | 等待中的模拟模型请求能被停止按钮取消；新建或切换对话时取消原请求；原对话的消息保存在原记录中，延迟返回的内容不得写入新对话；查看其他题目的历史时可以输入草稿，发送条件由当前题目状态决定 |
| Agent 工具 | 读取真实编辑器代码、语言及本站作答记录；检查未登录时的提示。错误高亮、清除高亮和代码变化后的拒绝处理使用真实 Monaco 编辑器验证；检查过程中保留用户代码，临时标记及时清除 |
| Markdown | 标题、加粗、有序及无序列表、引用、表格、行内代码、围栏代码块、语言高亮和链接正确显示；实际点击代码复制按钮并检查反馈；同一轮工具调用和回答正确展示，原始 HTML 内容不能执行 |
| LaTeX | `$...$` 行内公式、单独成行的 `$$` 独立公式、分数、求和、上下标、根式和矩阵正常显示；代码中的美元符号保持原样；错误公式显示错误内容且聊天界面可继续使用；字体从插件或本地开发服务加载 |
| 窄侧边栏布局 | 在实际窄侧边栏中检查，记录当前宽度，要求 `document.documentElement.scrollWidth <= document.documentElement.clientWidth`。长代码、宽表格和长公式在各自区域滚动；需要确认外观时保存截图并实际查看 |
| 自动提交与心得卡 | 修改提交钩子、计时或记录流程时运行已有 `node tools/test-auto-record.mjs`；修改登录引导时运行已有 `node tools/test-login-guide.mjs` |

- 实际点击和键盘输入用于验证交互；通过 JavaScript 直接设置输入值只能作为辅助，不能替代输入框交互检查。
- 检查 DOM、插件存储和模型请求内容中的具体结果，并对不满足预期的情况终止检查、报告失败。
- 查看浏览器控制台，定位本次修改产生的异常。测试账号未登录产生的鉴权错误，应结合对应请求确认原因。
- 对已经充分验证的行为停止重复检查；只有存在具体剩余问题时才补充相关检查。

#### 4. 清理临时状态并检查构建

- 无论检查成功或失败，都通过 `finally` 恢复原模型配置、`fetch` 和消息 API，删除本次创建的临时对话、标记及临时存储项。只清理本次记录的编号，保留原有对话和登录态。
- 关闭本次测试启动的浏览器和开发服务。结束进程时使用本次启动的进程编号。
- 截图、临时脚本和检查结果保存在 gitignored 的 `.mcp-artifacts/`。沿用已有测试脚本；当前聊天专项检查可以使用临时端到端脚本，新增单元测试仍需用户明确要求。
- 在 `extension/` 下运行 `npm run compile` 和 `npm run build`，并检查 `git diff --check`。最终生产构建应包含当前源码及所需字体等资源。

#### 5. 发布与结果说明

- 按当前任务已有的提交、推送和合并授权执行发布，提交时圈定本次修改文件。
- 需要发布插件时，推送后确认 `Build extension ZIP` 工作流对应本次提交，等待完成后检查产物存在且未过期，再提供下载链接。
- GitHub Actions 当前执行依赖安装、类型检查、构建及 ZIP 打包；浏览器检查由上述流程执行。
- 结果说明写明实际执行的浏览器场景、是否使用模拟模型、类型检查及构建结果。没有执行的项目不能报告为通过。
- 更新已解压插件时，用新版文件覆盖原插件目录，再到 Chrome 扩展管理页面点击「重新加载」。

## 常用命令

```bash
npm run dev          # 前端本地开发
npm run build        # 类型检查（前端+API）+ 构建 → dist/
npm run dev:api      # 本地起 API（含 functions + 本地 D1）
npm run deploy       # 构建并部署到 Cloudflare Pages（含 D1 绑定）
```

## 架构速览

- 前端：React 19 + Tailwind v4 + Vite，纯静态 SPA；题库数据内联在 JS 包中（运行时零数据请求）
- 后端：Cloudflare Pages Functions（`/api/*`）+ D1 SQLite；鉴权为会话 Cookie（账号密码登录，插件以此同步登录态）或 `Authorization: Bearer <api_key>`
- 题库是打包进前端的静态数据 `src/data/problems.json`
