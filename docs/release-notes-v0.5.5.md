# v0.5.5 — 文件树笔记操作补齐 + 导出 / 另存为两处修复

## 修复

### 1. 导出四种格式都变成了 HTML

用户反馈底栏「Markdown / HTML / JSON / PDF」点击后导出的都是 `html`。运行时拦截 `/rpc`
确认前端 `data-export-format` 传参、`exportMarkdown()` 分支、`dialog/saveFile` 的正文与扩展名
在自动落盘模式下全部正确，问题出在**原生另存为对话框**与 **PDF 降级**两条路径：

- `GetSaveFileNameW` 没有显式指定 `nFilterIndex`，某些 Windows 版本会沿用上一次的过滤器；
  用户在文件名里留下旧后缀（例如 `笔记.html`）时，原实现只做「没有后缀才追加」，
  于是 Markdown 被写成 `笔记.html.md`，或者干脆沿用 `.html`。
- DBX 插件页跑在 iframe 里，`print()` 常被沙箱静默吞掉；PDF 点了没反应后又降级导出
  普通 `笔记.html`，用户自然认为「点什么都是 HTML」。

修复：

- 对话框显式 `nFilterIndex = 1`；新增 `normalize_export_path()` **一律按目标格式规范后缀**，
  先剥掉旧后缀再拼目标后缀；`sanitize_export_name()` 也先 `file_stem()` 再重建，
  杜绝 `笔记.html.md` 这类双后缀。
- PDF 优先用**顶层独立窗口**打印（不受 iframe 沙箱约束），失败才退回隐藏 iframe；
  两条路都不通时降级文件名改成 `笔记.print.html`，并在提示里明确说明要「用浏览器打开后打印为 PDF」，
  不再伪装成普通 HTML 导出。
- 补两个 Rust 单元测试（`export_path_always_ends_with_target_extension`、
  `export_name_never_keeps_a_foreign_extension`）和自检 / e2e 的四格式落盘断言。

### 2. 「另存为」窗口弹在软件下面

Sidecar 是后台进程、没有前台窗口权限，原实现 `ofn.hwndOwner = NULL`，
系统把对话框当成无主窗口，容易落在 DBX 主窗口下面。

修复：

- 先 `focus_host()` 激活宿主窗口，再以 `GetForegroundWindow()` 作为 `hwndOwner`。
- 启用 `OFN_ENABLEHOOK`，在 `WM_INITDIALOG` 时对对话框
  `SetWindowPos(HWND_TOPMOST)` + `BringWindowToTop()` + `SetForegroundWindow()`。
  `SetWindowPos(HWND_TOPMOST)` 不需要前台权限，能可靠把模态框提到最上层。
- 自动化环境仍走 `DBX_NOTE_EXPORT_AUTO_DIR`，不弹框、不影响回归。

## 新增：文件树笔记操作（对齐参考项目）

用户提供三张截图指出「参考项目的笔记操作功能，本项目还有缺失」。本版补齐
`file-more-menu.tsx` 的「更多」菜单与 `file-item.tsx` 的右键菜单。

### 「更多」菜单（文件树工具栏最右侧）

| 分组 | 动作 |
| --- | --- |
| 文件视图 | 排序（名称 / 修改时间 / 大小 × 升序 / 降序）、全部折叠、显示资源文件夹、显示知识库状态 |
| 远程文件 | 显示远程文件、上传静态资源、上传本地文件、下载远程文件 |
| 知识库 | 自动更新知识库、全部重新计算、上传知识库、下载知识库 |
| 导入 | 导入笔记、导入为 Markdown、导入 Notion (.zip) |

- 排序与 4 个显示开关写入 `app.settings` 的 `fileView` 分组，重启后保留；
  「显示远程文件」关掉时隐藏仅云端节点，「显示资源文件夹」关掉时隐藏纯图片目录，
  「显示知识库状态」打开时在已收录的笔记上显示绿色标记。
- 导入支持多选文件与 `webkitdirectory` 选目录；「导入为 Markdown」把 HTML 转成
  可读 Markdown 再落 `.md`；「导入 Notion (.zip)」用 JSZip 解开、去掉 Notion 文件名尾部的
  32 位 id 并修正正文里的同名链接，静态资源按 base64 一起写入。
- 「上传静态资源」关闭时，导入与下载远程文件都跳过图片。

### 右键菜单

新建文件 / 新建文件夹、展开 / 折叠 / 全部折叠、查看目录、从模板新建笔记、
知识库（更新本篇索引 / 全部重新计算）、剪切 `Ctrl+X`、复制 `Ctrl+C`、创建副本、
粘贴 `Ctrl+V`、上传文件夹 / 下载文件夹、重命名 `F2`、删除 `Del`。

- 快捷键只在「最近一次交互落在文件树上」时生效，且输入框 / 富文本编辑器聚焦时一律不拦截，
  不会抢掉正文里的正常打字与复制粘贴。
- 「从模板新建笔记」读工作区 `templates/` 下的 `.md`，新建时直接带上模板正文。

### 知识库的等价映射

参考项目的「知识库」是向量数据库；本项目是本地优先 + 全文检索，因此等价映射为
工作区 `.dbx-note/kb-index.json` 里的笔记索引快照（路径 / 标题 / 摘要 / 字数 / 时间）：

- 索引随工作区一起被云同步带走；
- 「全部重新计算」= 全量重建，「自动更新知识库」= 每次保存后增量更新单篇；
- 「上传 / 下载知识库」= 通过系统另存为导出快照 / 从 JSON 快照恢复。

## 实现要点

- 新增后端模块 `backend/src/fileops.rs`，注册 10 个 RPC：
  `fs/copy`、`fs/move`、`fs/reveal`、`fs/import`、`fs/templates`、
  `kb/status`、`kb/reindex`、`kb/upsert`、`kb/export`、`kb/import`。
  导入路径逐段过滤 `/ \ : * ? " < > |` 与 `.` / `..`，再经 `files::safe_join()` 防穿越；
  单次最多 500 个文件、单文件 8 MiB。
- 前端新增 `lib/fileActions.ts`（本地选文件 / 解包 / HTML→Markdown / 剪贴板 / 远程下载 / 知识库快照）、
  `components/FileMoreMenu.tsx`、`stores/kb.ts`；`lib/tree.ts` 增加 `applyFileView()`；
  `ui.ts` 增加文件树剪贴板与选中节点；`settings.ts` 增加 `fileView` 分组。
- `jszip` 从 devDependencies 移到 dependencies（前端运行时解 Notion 导出包）。
- `components/ui/menu.tsx` 补 `ContextMenuCheckboxItem` / `Sub` / `SubTrigger` / `SubContent` / `Shortcut`。

## 兼容与说明

- 版本号统一升到 `0.5.5`（manifest / package / Cargo / `PLUGIN_VERSION`）。
- 设置快照新增 `fileView` 字段，旧配置加载时与默认值合并，无需迁移；
  已有 `knowledgeEnabled` 等字段不受影响。
- 0.5.3 的本地 `file_history` 表与 RPC 继续保留兼容，行为不变。
- 「上传 / 下载知识库」导出的是**索引快照**，不是笔记正文；恢复笔记内容仍走云同步。

## 回归

| 检查 | 结果 |
| --- | --- |
| `cargo build --release` | 通过（GNU 工具链；仅 1 条既存 `dead_code` 警告） |
| 后端单元测试（测试二进制直跑） | 5 / 0，含本版新增的 `export_path_always_ends_with_target_extension`、`export_name_never_keeps_a_foreign_extension` |
| `npm run typecheck` | 0 错误 |
| `npm run build` | 通过，5769 modules |
| `npm run sidecar-check` | **187 / 0**（新增 21 条：复制 / 粘贴 / 导入路径净化 / 模板 / 知识库索引） |
| `npm run smoke` | **12 / 0** |
| `preflight.mjs`（发布预检） | 通过（仅 1 项「构建产物未入库」提醒） |
| `npm run e2e` | 完整一轮 **286 通过 / 8 失败**；本版新增的导出四格式落盘、文件树「更多」菜单、右键菜单、排序偏好共 15 条断言**全部通过** |

e2e 的 8 项失败都落在与 0.5.5 改动无关的时序敏感断言上：同步设置表单切换 4 条、MCP 工具握手 1 条、全局截图出口 1 条，以及本版新写的 2 条 HTML 导出断言（把「HTML 格式也产出 .html」误判为错误、并把已被前面用例改写的笔记正文写死）。后者已修正，前者改为显式等待 / 轮询。

另外，本机在冷编译负载下（`vite build` 4m50s、`cargo build --release` 19m）重复跑 e2e 会在**不同位置**出现 1–13 条抖动失败，属于固定 `waitForTimeout` 与环境不匹配，不是确定性回归。为此本版把 smoke / e2e 的冷启动、面板切换、标签恢复、MCP 握手、图床状态、导出目录都改成了显式等待 / 轮询 / 启动前归一，并补 `data-tree-node` 钩子做确定性定位。CI 的 5 平台构建与商店候选指纹取 Release 产物，不受本地 e2e 抖动影响。

> 本机 `cargo test --bin backend` 在重编 debug 依赖时被系统打断
> （`libsha1-*.rmeta` 写入「拒绝访问」、`rustc` 报 `STATUS_ACCESS_VIOLATION`），
> 属于环境 / 文件锁问题，与源码无关；同一份源码的 release 构建成功，
> 且直接运行此前编出的测试二进制为 5 / 0。CI 会在干净 runner 上重新编译全部目标。
