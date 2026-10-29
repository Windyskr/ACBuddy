# ACBuddy 🔥

面试高频 LeetCode 题目整理与刷题记录工具。
纯静态 SPA（React + Tailwind），筛选、排序、搜索全部在浏览器端完成，可直接部署到 Cloudflare Pages。

![技术栈](https://img.shields.io/badge/React-19-blue) ![Tailwind](https://img.shields.io/badge/Tailwind-v4-38bdf8) ![Vite](https://img.shields.io/badge/Vite-6-purple) ![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-f6821f)

## 功能

- **题目列表**：显示题号、中文名、难度（简单/中等/困难）、力扣标签，点击标题直达力扣题目页（国内版或国际版，在「显示设置」里切换；剑指 Offer 等国内版独有题始终打开国内版）
- **组合筛选**：难度 × 掌握程度 × 标签 × 最新结果 × 个人标签（后两项需登录），筛选按钮直接显示选中的值
- **搜索**：按题目名称或题号实时过滤
- **排序**：点击表头按难度 / 最近作答 / 掌握程度排序，再点切换升降序，第三次点击恢复默认顺序
- **学习进度**：
  - 「掌握程度」★×5（了解 → 精通），拉满即视为已完成；「紧急程度」!×3
  - 「个人标签」每题最多 10 个（需登录）
  - 「笔记」为每道题记录解题思路，支持简单 Markdown；点击行或标题旁的笔记图标展开笔记与作答记录
  - 「最近作答」（登录后）：最近一次作答的结果与日期
  - 筛选栏显示当前题数与已完成数，悬停可看三档难度的完成数（已完成 = 有 AC 记录 **或** 掌握拉满）
  - 还没设置的星级、紧急标记和标签入口只在悬停或展开该行时出现；只有登录后才有内容的列游客不显示
- **两种使用方式**：不登录时进度存在浏览器 localStorage；登录后存到账号，并与浏览器扩展双向同步。
  首次登录会把本地已记录的进度自动合并上去，不会丢
- **表格自定义**：列可拖拽排序、拖拽调宽、按需隐藏（「紧急」默认隐藏，可在「显示列」里打开），设置持久化
- **分页**：20 / 50 / 100 条每页，带页码省略号

## 安装浏览器插件

插件在力扣国内版和国际版提交后自动记录结果和用时，弹出心得卡，侧边栏提供计时和 AI 辅导，记录同步到网站。

- **Chrome**（116 及以上版本）：从 [Chrome 应用商店](https://chromewebstore.google.com/detail/acbuddy/hkjijhnnjghgndikpiaaeanilgpjfhfk)安装
- **Edge**：打开同一个商店链接，先点页面顶部的「允许来自其他商店的扩展」，再添加
- **无法访问 Chrome 应用商店**：按[安装指南](https://acbuddy.pages.dev/install)从 GitHub Actions 下载安装包，用开发者模式加载

装好后在同一个浏览器登录 ACBuddy，打开力扣题目即可使用。

## 快速开始

```bash
npm install
npm run dev       # 本地开发 http://localhost:5173
npm run build     # 类型检查 + 产物构建 → dist/
npm run preview   # 预览构建产物
```

## 部署到 Cloudflare

### 方式一：本机一条命令（需先 `npx wrangler login`）

```bash
npm run deploy    # = npm run build && wrangler pages deploy dist
```

首次部署会自动创建 Pages 项目 `acbuddy`，之后输出访问地址
`https://acbuddy.pages.dev`。

### 方式二：GitHub Actions 自动部署

工作流文件当前是**停用**状态（`.github/workflows/deploy.yml.disabled`），改名去掉
`.disabled` 后缀即可启用，然后：

1. 在仓库 Settings → Secrets 添加：
   - `CLOUDFLARE_API_TOKEN`（权限：Cloudflare Pages: Edit）
   - `CLOUDFLARE_ACCOUNT_ID`
2. push 到 `main` 即自动构建部署

> 注意：工作流只部署前端与 Functions，**不会执行数据库迁移**。schema 有变更时
> 仍需手动跑一次 `npm run db:migrate:remote`。

### 方式三：Cloudflare 控制台 Git 集成

Workers & Pages → 创建 Pages 项目 → 连接 Git 仓库，构建命令 `npm run build`，输出目录 `dist`。

## 后端 API（Chrome 扩展数据通道）

- 技术栈：Cloudflare Pages Functions（`functions/api/[[route]].ts`）+ D1 SQLite（`acbuddy-db`），随 `npm run deploy` 一体部署
- 接口以 `functions/api/[[route]].ts` 为准，文件头写了认证、响应格式和字段语义 —— 记录作答耗时（通过/未通过）、笔记、掌握程度
- 鉴权：会话 Cookie（网页/扩展）或 `Authorization: Bearer <api_key>`；密钥查询 `npm run db:key:remote` / `db:key:local`
- 本地调试：`npm run dev:api` → http://localhost:8788/api/health

### 数据库迁移

迁移由 `scripts/db-migrate.mjs` 执行，`schema_migrations` 表记账，重复执行是空操作：

```bash
npm run db:migrate:local     # 补齐本地所有未执行的迁移（保留数据）
npm run db:migrate:remote    # 同上，作用于线上库
npm run db:migrate:status    # 查看账本
npm run db:reset:local       # 清空重建（本地专用，会删数据）
npm run db:seed:local        # 创建开发账号，随机密码只打印一次
```

新增 schema 变更请**新建编号文件**，不要修改已有的迁移。

### 部署前必读：环境变量

公开部署时在 Cloudflare Pages 的环境变量里配置：

| 变量 | 作用 | 说明 |
| --- | --- | --- |
| `SITE_ORIGIN` | 生产站点 Origin | 默认 `https://acbuddy.pages.dev`，自建部署改成自己的域名 |
| `EXTENSION_IDS` | 扩展 ID 白名单（逗号分隔） | **强烈建议设置**。留空时任何已安装的扩展都能以用户身份调用 API |
| `ALLOW_DEV_ORIGINS` | 放行 `http://localhost:*` 携带凭证 | **生产环境不要设**；本地开发写进 `.dev.vars` |

会话 Cookie 是 `SameSite=None`（浏览器扩展需要），所以上面的来源白名单是唯一的
CSRF 防线，放进去的来源等同于能代表用户读写全部数据。安全响应头（CSP、
`frame-ancestors`、nosniff 等）在 `public/_headers` 里，改动前请确认没有削弱它们。

服务端内置了注册/登录限流与每用户行数配额，具体数值见 `functions/api/[[route]].ts` 里的 `RATE_LIMITS` 与 `QUOTAS`。

## 题库数据

题库是打包进前端的静态文件 `src/data/problems.json`（格式见 `src/types.ts` 的 `ProblemData`），运行时不发起数据请求。

## 目录结构

```
├── agents.md                   # AI 代理开发约定（开发阶段声明）
├── public/_headers             # Cloudflare Pages 安全响应头（CSP / frame-ancestors / 缓存）
├── functions/api/[[route]].ts  # Pages Functions 后端（/api/*），即接口契约
├── migrations/                 # D1 基础 schema 与保留数据的增量迁移
├── scripts/
│   ├── db-migrate.mjs          # D1 迁移执行器（schema_migrations 账本）
│   └── db-seed.mjs             # 创建开发用户并打印 api_key
├── src/
│   ├── data/problems.json      # 题库数据（打包为独立 chunk，运行时零数据请求）
│   ├── App.tsx                 # 状态中枢：筛选/排序/分页/本地存储
│   ├── components/             # Header / FilterBar / ProblemTable / Pagination / InstallGuide 等
│   ├── lib/filters.ts          # 过滤、排序、分页纯函数
│   ├── lib/markdown.ts         # 极简 Markdown 渲染（先转义再生成标签）
│   ├── lib/storage.ts          # useLocalStorage（写入节流）
│   └── types.ts
├── extension/                  # 浏览器插件（WXT + React，Manifest V3）
├── .dev.vars.example           # 本地开发环境变量模板（复制为 .dev.vars）
├── wrangler.jsonc              # Cloudflare Pages + D1 绑定配置
└── .github/workflows/
    ├── extension-zip.yml       # 插件有改动时构建 ZIP 安装包
    └── deploy.yml.disabled     # GitHub Actions 部署（默认停用）
```

## 许可

代码以 [MIT License](LICENSE) 开源。

题库数据（`src/data/problems.json`）归原站点所有，本仓库仅作学习交流用途，不适用 MIT 许可。如有异议请发邮件到 acbuddy@seek.li，我会立即移除。
