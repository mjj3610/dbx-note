# v0.5.10 发布说明（打开笔记 / 上传文件性能）

> **发布状态**：`dev` 分支实现，**未打 tag、未发 Release、未提商店候选 PR**。
> 本版只解决用户反馈的两个体感问题：① 打开笔记慢；② 上传文件无响应 / 很慢。
> 版本号统一为 `0.5.10`；部署与回滚见 `docs/版本部署变更说明-v0.5.10.md`。
> **本地安装包已构建并完成安装验证**，见第 7 节。

## 1. 需求与根因

用户反馈：

- 「打开笔记文件很慢」；
- 「上传文件无响应或者很慢」，并要求对照参考项目逻辑优化。

只读排查结论：

### 1.1 打开笔记慢

旧版 `src/stores/notes.ts::open()` 的顺序是：

```
flushPendingSave() → pullOnOpen(path) → rpc.readFile(path) → 渲染
```

`pullOnOpen()` 在 Git 通道会先 `syncPrefs()` + `syncStoreOptions()`，再走
`syncCompare(path)`；后端 `gitsync::compare()` 里会调用 `fetch_snapshot(app)`，
等价于每次**打开本地笔记都先等一次 Git fetch / 网络往返**。

参考项目（`note-gen-note-gen-v0.39.2`）是相反的三段式：

1. `setActiveFilePath()` 先 `set({ currentArticle: '', activeFilePath, loading })` 乐观切换；
2. `readArticle()` 本地 `readTextFile()` 后立刻 `set({ currentArticle, loading: false })` 渲染；
3. 之后才 `await syncOnOpen()` 做网络比对，结果通过 `emitter` 覆盖，网络失败静默。

### 1.2 上传文件无响应 / 很慢

- `pickFiles()` 只靠 `window.focus` + `setTimeout(350ms)` 判定取消。DBX 宿主把插件放在
  iframe 里，原生对话框关闭时**不一定给 iframe 派发焦点事件**，Promise 可能永远不
  resolve，调用方一直 `await`，表现为「点了没反应」；
- 从点菜单到系统对话框弹出、转码、批量写盘、成功提示全程**零反馈**；
- `buildImportEntries()` 用 `for … await readText/readBase64` 严格串行读文件；
- 导入成功后 `await loadTree()` 做一次全量目录重扫，并顺带触发 `sync/remoteTree`
  （一次 git fetch）；大工作区 / 网络慢时这一步尤其明显。

## 2. 打开笔记：先读盘渲染，后台再比对

`src/stores/notes.ts` 把 `open()` 拆成 `performOpen()` + `enqueueOpen()`：

- **乐观切换**：本地文件先同步 `set({ tabs, activePath, title, content: '', loadingFile: true })`，
  标签栏和标题立刻响应；「仅云端」节点因本地没有文件，仍等下载完再切，行为不变。
- **关键路径只剩 `rpc.readFile(path)`**：读到内容立即 `set({ content, savedContent, loadingFile: false })`。
- **远端比对移到后台**：`scheduleBackgroundPull()` 统一发 `pullOnOpen()`，网络失败静默。
  Git 通道直接回传正文；对象存储整批拉取后重读一次磁盘。
  同一时刻只允许一个比对在飞，快速连点时只保留最后一次（避免堆 git 进程）。
- **竞态防护**：
  - `openGeneration`：慢请求回来时不覆盖后来点开的文件（对齐参考项目 `articleReadGeneration`）；
  - `pendingOpens`：同路径并发打开复用同一个 Promise（对齐 `pendingArticleReads`）；
  - 后台结果只在 `activePath === path` 且**没有本地未保存改动**时应用；若比对期间用户
    已开始输入，弹冲突对话框决定保留哪边，避免下次自动保存把远端版本写回去。

语义没有退化：冲突仍弹窗、离线仍静默、「仅云端」仍先下载、真实远端更新仍会覆盖编辑器。

## 3. 上传 / 导入：即时反馈 + 并发读取 + 增量插树

### 3.1 文件选择不再挂起（`src/lib/fileActions.ts`）

`pickFiles()` 改为三重兜底：

1. `cancel` 事件（Chromium / WebView2 原生取消信号）；
2. `focus` / `visibilitychange` 后 120ms 判定（旧版是纯 350ms 等待，且会在 `change`
   尚未派发时把已选文件丢掉），只在 `input.files` 为空时才结算；
3. 模块级 `activePickerCancel`：再次点「上传文件」时先把上一次未结算的选择当取消处理，
   保证调用方一定能继续。

### 3.2 进度可见

- 新增 `ImportStage = 'picking' | 'reading' | 'writing'` 与 `makeImportFeedback()`：
  点菜单立刻出 `toast.loading`，读取阶段按 `current/total` 更新（每 5 个刷新一次），
  写盘阶段单独提示；结束用 `endImportFeedback()` 关掉。
- `src/lib/i18n.ts` 补中 / 英 4 个键，ja / ko / th 通过英文回退。

### 3.3 并发读取

`buildImportEntries()` 改用 `mapConcurrent()`（6 路并发、保持输入顺序），
notes / markdown / notion 三条导入路径都受益；不再逐个 `await` 串行读盘。

### 3.4 增量插树取代全量重扫

- `src/lib/tree.ts` 新增 `insertLocalPaths()`：按后端返回的精确落盘路径建目录链，
  同名节点清掉 `remoteOnly` / `remoteUpdated`；
- `src/stores/notes.ts` 新增 `applyLocalPaths(paths)`；
- `FileTree` 的 `uploadFile` / `uploadFolder` / 下载远程文件，以及 `FileMoreMenu` 的
  `doImport` / 下载远程文件，都改为 `applyLocalPaths(result.paths)`，
  **不再 `await loadTree()`，也不再顺带触发 `sync/remoteTree`**。

参考项目拖拽导入用 `addFile()` 增量插树，但 `use-markdown-import` 之后仍全量
`loadFileTree()`；本版把这一点做得更彻底。

## 4. 兼容性

- 零新增 npm 依赖、零新增权限（`manifest.permissions` 仍为 `[]`）、零表结构变更、
  零 SQL / 迁移脚本、零新增 RPC；
- 所有改动都在前端（除版本号），Sidecar 协议与后端行为不变；
- 远端更新覆盖、冲突弹窗、自动同步抑制窗口（1s）、知识库增量索引均保持原语义；
- 文件树增量插入后 `expandTo()` 展开父目录，用户能立刻看到新文件。

## 5. 回归

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npm run build` | 通过 |
| `cargo test --bin backend` | **27 / 0** |
| `cargo check` | 通过（1 条既存 `dead_code` 警告） |
| `npm run sidecar-check` | **212 / 0**（1 条剪贴板环境跳过） |
| `npm run smoke` | **36 / 0**，新增 2 条本版回归 |
| `npm run e2e` | **344 通过 / 6 失败**，6 条均为本机锁屏 / 远程会话无法注入全局热键的既有截屏环境项 |

新增的两条 smoke 回归：

1. **同步 RPC 挂起时打开笔记仍能渲染正文**：把 `sync/*`、`store/*`、`s3/*` 全部替换成
   永不结算的 Promise，再点回另一篇笔记。旧版会卡在 `pullOnOpen()` 永远不渲染；
   新版直接读盘，2.5s 内正文出现。
2. **上传后文件树增量出现新节点**：通过 Playwright `filechooser` 真实选一个 `.md`，
   断言新节点立即出现在树里。

## 6. 发布

本版**暂不发布**。需要在用户确认后执行：打 tag / Release → 等 5 平台 CI →
生成候选 → 提 DBX Store PR。当前商店候选仍是 v0.5.9 的 PR #507（等待维护者 `/sign`）。

## 7. 本地安装包与安装验证

`backend/` 目录内 `cargo +stable-x86_64-pc-windows-gnu build --release`（3m52s，
编译 `dbx-note-backend v0.5.10`）+ `npm run build` 重建 `ui/` 后，用
`node scripts/package.mjs` 生成：

| 项目 | 值 |
| --- | --- |
| 包 | `release/com.mjj3610.note-0.5.10-windows-x64.dbxp` |
| 大小 | **3,947,816 B** |
| sha256 | `dbd0071644fde9e634f211c5714fd893f85fb2a5a4ae68b8aaa212565572596c` |
| 包校验 | **16 / 0**：大小 / sha256 / checksums（12/12）/ manifest `0.5.10` / 后端入口 / 权限空 / 包内 Sidecar 与磁盘字节一致 / 前端含导入进度与增量插树标记 |
| 包内 Sidecar 协议自检 | **214 / 0** |
| 包内 Sidecar 握手 | `plugin/initialize` → `version=0.5.10`，`ping` → `{"ok":true,"version":"0.5.10"}` |

宿主目录按既有格式**纯增量落盘**（不修改 / 不删除 0.5.8 / 0.5.9）：

- `versions/0.5.10/`（13 文件，checksums 12/12 复核通过）；
- `activations/00000000000000000038-3ee9909c-e14f-4d4b-acd0-9a326826ed33.json`
  （sequence 38，previousVersion 0.5.9）。

从宿主目录 Sidecar 跑握手同样回报 `version=0.5.10`。
回退：删掉 `versions\0.5.10\` 与 `activations\00000000000000000038-*.json` 即回到 0.5.9。
