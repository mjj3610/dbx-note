# v0.5.4 — 导出与历史版本严格对齐参考项目

## 修正

0.5.3 的编辑器底栏虽然补齐了「复制 / 导出 / 历史版本」入口，但两处语义与参考项目不一致：
导出只是浏览器 `Blob` 下载（在 DBX 的 iframe 里可能什么都存不下来，也没有明确落盘位置），
历史版本是本地 SQLite 自动快照（参考项目读的是远端 Git 仓库的 commit 列表）。本版按用户选择
**「历史版本与参考项目一致 + 导出走系统另存为对话框」** 重写这两块。

### 导出：明确落盘位置

- **系统「另存为」**：Windows 下调原生 `GetSaveFileNameW`，由 Sidecar 把内容写到用户选定的路径，
  并把**实际保存路径回显在提示里**；在对话框里点取消则不写盘、也不报成功。
  macOS / Linux 暂不支持原生对话框时降级为浏览器下载，并在提示里说明是降级。
- **JSON 改成 Tiptap JSON 文档**（`MarkdownManager.parse`），不再是 `marked.lexer()` 的 token 树，
  可直接被 Tiptap 编辑器读回。
- **HTML 内联工作区图片**：通过 `fs/readImage` 把 `assets/…` 之类的相对图片换成
  `data:…;base64,…`，导出的 HTML 离开工作区也不丢图；远端 http(s) 图片保持原样。
- **PDF** 仍走系统打印窗口，补了「准备 PDF」提示、图片 / 字体加载等待、`afterprint` 清理；
  打印被禁时降级导出 HTML 并说明，不静默失败。

### 历史版本：远端 Git 提交历史

- 数据源改为**当前笔记在远端仓库的提交历史**（最近 10 条），每条显示短 sha（点开远端 commit 页）、
  提交说明、作者、时间，面板顶部提供「在仓库中打开」链接；恢复按完整 sha 取该提交的正文。
- 入口由后端 `history/status` 判定：仅当同步平台是 **GitHub / Gitee / GitLab / Gitea**、
  工作区是**独立** Git 仓库并配置了 `origin` 时显示，其它同步方式下整个入口隐藏
  （与参考项目 `supportsHistory` 一致）。
- 恢复是写操作，按本项目规范增加**二次确认**；恢复前先把编辑器里未落盘的改动强制写盘，
  避免被 800ms 防抖保存覆盖回去。
- 宽屏用 Popover，窄屏（≤860px）改为贴底 Drawer，小窗里浮层不会再被裁切。

## 实现要点

- 参考项目直接调四家平台的 REST API。本项目工作区本身就是 Git 仓库、已有 `origin` 与平台令牌，
  因此用 `git fetch` + `git log <remote-ref> -- <path>` + `git show <sha>:<path>` 取到的是
  **同一份远端提交历史**，不必维护四套 REST 客户端，且已 fetch 的离线历史同样可看。
  提交链接按平台拼：GitLab 用 `/-/commit/`、`/-/blob/`，Gitea 用 `/src/branch/`，其余用
  `/commit/`、`/blob/`。
- 新增后端模块 `backend/src/githistory.rs` 与 4 个 RPC：
  `dialog/saveFile`、`history/status`、`history/commits`、`history/content`。
  `history/content` 只接受 40 / 64 位十六进制 sha，避免拼进 `git show` 的 refspec。
- 前端删除 `editor/HistoryMenu.tsx`，新增 `editor/HistorySheet.tsx`；
  `markdownExport.ts` 全部重写，`EditorFooterBar` 改为传入 `{ path, markdown }` 内容源。
- 自动化回归用 `DBX_NOTE_EXPORT_AUTO_DIR` 跳过模态框写固定目录、
  `DBX_NOTE_HISTORY_OFFLINE=1` 跳过联网 fetch；生产环境都不设置，行为不变。

## 兼容与说明

- 0.5.3 的本地 `file_history` 表与 `history/list` / `history/get` / `history/create` RPC
  **保留**（数据不丢、其它调用方不受影响），只是前端历史版本入口不再使用它们。
- 无新增权限（仍是 `permissions: []`）、无新增监听端口、无数据库表结构变更，覆盖安装即可。
- 升级后若没配置 Git 远端，底栏不会显示「历史版本」；在设置页配置 GitHub / Gitee / GitLab /
  Gitea 同步并让工作区成为独立 Git 仓库（设置 `origin`）后，窗口回到前台或重新打开笔记即会出现。
- 历史版本恢复不会自动创建新的 Git 提交；需要保留当前版本请先自行 commit / push。

## Platform support

| 平台 | 主流程 | 复制 | 导出 | 历史版本 | 截图 / 剪贴板位图 / 录音 / 系统 OCR |
| --- | --- | --- | --- | --- | --- |
| Windows x64 | 可用 | 可用 | 系统另存为（回显路径） | 可用 | 可用（GDI / 剪贴板 / cpal / WinRT） |
| macOS（arm64 / x64） | 可用 | 可用 | 浏览器下载降级（提示保存位置） | 可用 | 桩实现，返回可读提示 |
| Linux（x64 / arm64） | 可用 | 可用 | 浏览器下载降级（提示保存位置） | 可用 | 桩实现，返回可读提示 |
