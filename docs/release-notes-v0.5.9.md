# v0.5.9 发布说明（dev 分支 / 知识图谱）

> **发布边界**：本版只在 `dev` 分支实现与验证，**未打 tag、未发 Release、未提交商店候选 PR**。
> 上游已上架版本仍为 v0.5.7，v0.5.8 候选 PR #501 仍在等待维护者 `/sign`。
> 已额外补做本机 release Sidecar 构建与可安装 `.dbxp` 验证（见 5.1），**仍属未发布**。
> 详细设计见 `docs/知识图谱设计-v0.5.9.md`，部署 / 回滚见 `docs/版本部署变更说明-v0.5.9.md`。

## 1. 需求

用户要求在「大纲」旁增加 wiki 知识图谱，并在评估后明确修正方向：

- 图谱**根据知识库向量化结果**生成，支持「发现 / 刷新」；
- 点「图谱」后在**中间大区**显示，并与**知识块联动**；
- 先评估可行性与性能 / 兼容性，再实现。

评估结论：可行且比「扫 Markdown 链接」更省事——图谱可以做成向量库的**只读派生视图**。

## 2. 后端：向量库派生图谱

`backend/src/knowledge.rs` 新增图谱派生层，复用 `load_chunks()` / `cosine()` / `lexical_terms()` / `bm25_score()`：

- `kb/graph`：按 `granularity`（source / chunk）生成 `{ nodes, edges, meta }`；
  - source 粒度对同一来源的分块向量做**均值池化**；chunk 粒度一节点一块；
  - 相似边走余弦 + **每节点相对 top-k**（默认 4），绝对阈值（默认 0.35）只作滑杆；
  - chunk 粒度额外画「同文档相邻块」结构边；
  - 未配置 embedding（占位向量 `[0.0]`）时**降级为对称 BM25** 并归一化到 0~1，图谱仍可用；
  - 节点 / 边硬上限 300 / 600；超过 `GRAPH_EXACT_LIMIT = 900` 启用词法倒排取 48 候选；
  - `meta` 带 `watermark / computedAt / dimension / strategy / truncated / nodeCount / edgeCount` 等。
- `kb/graph/neighbors`：以某个 `nodeId` 为中心取最相近的一批节点组成局部子图，供「发现关联」合并。
- **水印缓存**：指纹由 `count` + `max(updated_at)` + `sum(included)` + `embeddingDimension` + `lastIndexedAt` 组成，覆盖 reindex / flags / deleteVectors / snapshotImport 等所有写数据入口；变化时自动重算，否则缓存命中。
- 两个 RPC 都不写表、不调用 embedding API；embedding 只留在 Sidecar 内，绝不进前端。

`backend/src/main.rs` 注册 `kb/graph` 与 `kb/graph/neighbors`，`PLUGIN_VERSION` 升到 `0.5.9`。

## 3. 前端：中间大区工作区

- `src/lib/rpc.ts`：`GraphNode / GraphEdge / GraphMeta / GraphSnapshot / GraphOptions` 与 `kbGraph()` / `kbGraphNeighbors()`；所有知识库写入类 RPC 成功后统一派发 `dbx:kb-reindexed`。
- `src/stores/graph.ts`：独立 store。**单 flight + 序号丢弃旧响应**，只在页签激活 / 手动刷新 / 改参数 / 发现时发请求；`checkStale()` 比对 `lastIndexedAt` 与 `computedAt` 标脏；`expand()` 按 id 合并局部子图。
- `src/stores/ui.ts`：`SidebarTab` 增加 `'graph'`；语义是「中间大区的一种视图」，不是侧栏面板。
- `src/components/graph/`：
  - `GraphWorkspace.tsx`：工具条 + 画布 + 右侧知识块详情 + 底部状态条；
  - `GraphCanvas.tsx`：纯内联 SVG + 固定 70 轮力导向布局，缩放平移只改 `<g transform>`，选中一跳高亮，双击发现；
  - `GraphControlPanel.tsx`：粒度、阈值、邻居数、搜索、节点列表、发现 / 刷新、stale / truncated / error 提示；
  - `ChunkDetail.tsx`：知识块正文、关联知识块列表、打开原笔记、发现关联。
- `src/App.tsx`：中间 Panel 改为**编辑器 / 画布始终挂载 + `hidden` 切显隐**，图谱覆盖在同 Panel 内。不改 `canvasPath`。
- `src/components/LeftSidebar.tsx`：第 5 个「图谱」tab（Network 图标），窄屏自动回到 editor pane，图谱页签隐藏通用搜索框。
- 联动：`editorBus.revealChunk` → `MarkdownEditor` 用「无空白 / 无 Markdown 标记」紧凑串做 16 / 10 / 6 字递减包含匹配，设选区并居中滚动；`EditorPane` 监听 `dbx-note:reveal-chunk` 做 15 次有限重试，源码模式先切回可视化。
- `src/lib/i18n.ts`：zh-CN / en 全量 30 个图谱键，ja / ko / th 核心词 + 英文回退。

## 4. 兼容性关键决策

**不能用条件渲染切换中间大区**。若写成 `graphMode ? <GraphWorkspace /> : <EditorPane />`，切回时 Tiptap / CodeMirror 会重建，丢掉 undo 栈、未保存内容、大纲标题索引与滚动位置。`hidden` 保活是本次最重要的兼容性约束，smoke 里有专门断言（`切换图谱时编辑器保持挂载`、`切回文件页签后编辑器内容仍在`）。

其余：零新增 npm 依赖、零新增权限、零表结构变更、零 SQL / 迁移脚本、不引 Worker / CDN；主题走 CSS 变量与 Tailwind 语义色；`manifest.permissions` 仍为 `[]`。

## 5. 回归

| 项目 | 结果 |
| --- | --- |
| `cargo check --bins` | 通过（1 条既存 `dead_code` 警告） |
| `cargo test --bin backend` | **27 / 0**（新增 3 条图谱单测：摘要截断、参数夹取、向量 / 词法打分分支） |
| `npm run typecheck` | **0 错误** |
| `npm run build` | 通过（5,380.78 kB JS / 74.60 kB CSS） |
| `npm run sidecar-check` | **214 / 0**（新增 9 条图谱协议断言全过） |
| `npm run smoke` | **34 / 0**（新增 9 条图谱界面断言全过） |
| `npm run e2e` | **351 通过 / 1 失败**（新增 11 条图谱断言全过） |

`sidecar-check` 新增断言：节点 / 边 / 元信息结构、水印与策略、节点字段完整、边两端在节点集合内、水印缓存命中、知识块粒度、发现接口子图、`nodeId` 校验、阈值收敛。

`smoke` 新增断言：图谱 tab 切到中间大区、控制器 / 详情区 / 画布或空态、编辑器 hidden 保活、粒度切换、手动刷新不报错、切回文件页签后正文仍在。

`e2e` 新增断言：工作区 / 控制器 / 详情区、hidden 保活、无后端错误、阈值与邻居数控件、节点数来自向量库、策略标识、选中节点显示知识块详情、画布选中态一致、发现关联不报错、打开原笔记后回到编辑器。

**e2e 结果**：351 通过 / 1 失败。唯一失败为「全局热键当场弹出标注工具栏」，属本机锁屏 / 远程会话无法注入全局热键的既有环境项，与图谱改动无关；`控制台无错误` 通过。

另做了 2 处**既有的 e2e 稳定性修正**（不改产品代码）：Gitee 平台选择改为轮询等 `aria-pressed` 落定；对象存储「保存」按钮取 `.first()` 并软失败，避免表单重建期出现两个同名按钮触发 strict mode 异常、把后续整轮用例（含图谱）全部中断。

### 5.1 本地 release Sidecar 与 `.dbxp` 安装验证

用户要求「接着补 release Sidecar 构建与本地 `.dbxp` 进行测试」，在 dev 分支额外完成：

| 步骤 | 结果 |
| --- | --- |
| `backend/` 目录内 `cargo build --release` | 通过，4m44s，编译 `dbx-note-backend v0.5.9`，Sidecar **4,471,296 B**（旧 v0.5.8 为 4,410,368 B） |
| `npm run build` 重建前端 | 通过，3m44s，`index-wCC71Yms.js` 5,380.78 kB / `style-C0CdtqyZ.css` 74.60 kB |
| `node scripts/package.mjs` | 生成 `release/com.mjj3610.note-0.5.9-windows-x64.dbxp`，**3,946,626 B** |
| 包内容校验（`.tmp/verify-package-059.mjs`） | **14 / 0**：大小 / sha256 / 12 条 checksums / manifest 版本 0.5.9 / 入口 `bin/windows-x64/backend.exe` / 权限为空 / 包内 Sidecar 与磁盘 release 产物字节一致 / 前端含 `data-graph-workspace`、`data-graph-control`、`kb/graph/neighbors`、`知识图谱` |
| 包内 Sidecar 协议自检 | 从 `.dbxp` 解出 `backend.exe` 到 `.tmp/pkg-verify/bin/windows-x64/`，`DBX_NOTE_BACKEND` 指向它跑 `scripts/sidecar-check.mjs` → **214 / 0**（含握手身份校验与 9 条图谱协议断言） |
| 包内 Sidecar 握手 | `protocolVersion=1`、`com.mjj3610.note@0.5.9`、`ping.version=0.5.9`；`kb/graph` 可用（空数据目录按预期降级 `lexical`）；`kb/graph/neighbors` 空 `nodeId` 正确返回 `invalid` |

包指纹：`release/com.mjj3610.note-0.5.9-windows-x64.dbxp`，**3,946,626 B / sha256 `fbd55dffdfcfb84b44fc3c12963278b9b6459c580e4bc71d9bcf98db2bff2998`**。

两点说明：

- `.dbxp` 与 `.artifact.json` 落在被 gitignore 的 `release/`，只供本机安装验证；正式 5 平台产物仍由打 tag 后的 CI 生成。
- 打包前需先把 `.tmp/stage` rename 到 `.tmp/stale-*`：WorkBuddy 的 safe-delete shim 会让 `scripts/package.mjs` 里的 `rmSync(stageDir)` 报 `genie-trash ETIMEDOUT`，移走旧目录后 `force: true` 直接返回，不触发回收站。

## 6. 变更文件

| 类别 | 文件 |
| --- | --- |
| 后端 | `backend/src/knowledge.rs`、`backend/src/main.rs`、`backend/Cargo.toml`、`backend/Cargo.lock` |
| 前端数据 | `src/lib/rpc.ts`、`src/stores/graph.ts`（新）、`src/stores/ui.ts`、`src/lib/editorBus.ts`、`src/lib/i18n.ts` |
| 前端 UI | `src/components/graph/*`（4 个新文件）、`src/App.tsx`、`src/components/LeftSidebar.tsx`、`src/components/EditorPane.tsx`、`src/components/MarkdownEditor.tsx` |
| 测试 | `scripts/sidecar-check.mjs`、`scripts/smoke.mjs`、`scripts/e2e.mjs` |
| 版本 / 文档 | `package.json`、`package-lock.json`、`manifest.json`、`docs/知识图谱设计-v0.5.9.md`、`docs/release-notes-v0.5.9.md`、`docs/版本部署变更说明-v0.5.9.md`、`README.md` |

## 7. 未做的事（按用户要求）

- 未创建 `v0.5.9` tag；
- 未创建 GitHub Release、未跑 5 平台 CI；
- 未生成商店候选 JSON、未向 `t8y2/dbx-store` 提 PR；
- 未改动 `.dbx-store.json` / `store-submission/PUBLISH.md` 里 v0.5.8 的已发布信息。
