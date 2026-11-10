# v0.5.6 — 知识库完整复刻 + 文件 / 文件夹右键菜单拆分 + PDF 导出修复

本版处理用户在同一轮反馈里指出的四个问题：

1. 「笔记文件夹和文件右键操作功能按钮不一样，请对齐参考项目进行完善」
2. 「导出按钮导出 PDF 时，弹出显示导出为 print.html，请检查」
3. 「另外知识库对照参考项目完成复刻实现」
4. 「全局截图的区域选择边框线颜色改为红色」

参考实现为 `/g/workspace/note-gen-note-gen-v0.39.2`。

---

## 1. 知识库：从索引快照换成真正的 RAG

### 之前的落差（0.5.5）

0.5.5 把参考项目的「知识库向量库」等价映射成工作区 `.dbx-note/kb-index.json`
里的笔记索引快照（路径 / 标题 / 摘要 / 字数 / 时间），没有向量、没有 embedding、
检索仍是 `fs/search` 全文匹配。参考项目实际是完整 RAG：

- `knowledge_sources` + `vector_documents` 两张表；
- Markdown 按标题栈分块，代码块 / 表格保持 atomic，超长块按句子再按字符硬切；
- 通过 `/embeddings` 批量（16）生成向量，失败退回逐条；
- 余弦相似度 + BM25（k1=1.2、b=0.75）+ RRF 融合；
- `.data/rag/manifest.json` + `pages/*.json` 快照随笔记云同步；
- AI agent 通过 `knowledge_search` / `cite_sources` 注入上下文并展示引用。

### 本版实现

后端新增 `backend/src/knowledge.rs`（约 1500 行），与基础表共用同一个 SQLite 库：

| 表 | 作用 |
| --- | --- |
| `knowledge_sources` | 每个笔记一条：`source_key = article:<相对路径>`、内容哈希、索引哈希、状态、`auto_calc` / `included` 开关 |
| `vector_documents` | `(filename, chunk_id)` 唯一；正文 + embedding JSON + 更新时间 |
| `kb_meta` | `embeddingModel` / `embeddingDimension` / `lastIndexedAt` |

- **分块**：`chunk_markdown(text, chunkSize=1000, chunkOverlap=200)`；标题栈随正文携带，
  代码块与表格 atomic，块级重叠回收；任何超过 chunkSize 的块都会按句子 / 字符硬切。
- **embedding**：从 `settings.ai.defaults.embedding` 解析模型，POST `{baseURL}/embeddings`
  （`input` / `encoding_format: 'float'`），批量 16，失败退回逐条。
- **索引**：内容哈希去重，`included=false` 时删掉该来源所有分块，事务内替换向量；
  支持单篇 / 整个文件夹 / 全量三种粒度。
- **检索**：query embedding 余弦 + 内存 BM25，两路各自截断 `topK*4`，
  按 `RRF_K=20`、`VECTOR_WEIGHT=0.7`、`LEXICAL_WEIGHT=0.3` 融合；
  返回 `items` / `context`（`文件：{path}\n{content}` 以 `\n---\n\n` 拼接）/ `sources`。
- **快照**：`kb/snapshotExport` 写工作区 `.dbx-note/rag-snapshot.json`（schemaVersion 2，
  含 sources、documents、维度、模型），`kb/snapshotImport` 整体事务恢复，随云同步换设备免重算。
- **纯词法降级**：未配置 embedding 模型时，`run_batch()` 不报错，改为登记来源并写入
  一个「仅词法」分块（向量位 `[0.0]` 占位，余弦恒为 0），BM25 检索与文件树知识库状态照常可用；
  之后配好模型再点「全部重新计算」会按哈希重算成真向量。

前端：

- `src/lib/rpc.ts` 换成 `RagStatus` / `RagOptions` / `RagSearchHit` / `RagIndexResult` / `RagFileFlags`
  与 11 条新 RPC；旧的 `kbReindex` / `kbUpsert` / `kbExport` / `kbImport` 从前端移除。
- `src/stores/settings.ts` 新增 `rag` 分组（`chunkSize` / `chunkOverlap` / `topK` / `threshold` /
  `autoVector` / `autoInject`），走既有的 `persistChain` 串行落盘。
- 新 `src/components/dialogs/settings/RagSection.tsx` 取代旧的两行占位页：
  状态卡（模型 / 来源 / 分块 / 维度 / 最近计算）、四项索引参数、两个开关、
  重建 / 清空（二次确认）、快照上传下载、检索诊断。
- `src/stores/kb.ts` 重写为 `status` / `paths` / `busy` / `refresh()` / `reindex()`；
  `EditorFooterBar.tsx` 新增 `KbStatusButton`（对齐参考项目 `vector-calc.tsx`，
  显示最后计算时间、点击全量重算、计算中转圈）。
- `src/stores/chat.ts`：优先 `rpc.kbSearch()` 注入混合检索上下文与来源，
  未配置 / 索引为空 / 后端不可用时降级为原来的本地全文检索。
- `src/stores/notes.ts` 保存后按 `rag.autoVector` 增量重算本篇向量。
- 设置页「AI 模型」放开 `embedding` 用途，补中英文文案。

旧版 `kb/status`、`kb/reindex`、`kb/upsert`、`kb/export`、`kb/import` 保留为
`knowledge::legacy_*` 兼容分发，旧调用方仍能拿到 `count` / `paths` / `updatedAt`。

## 2. 文件夹 / 文件右键菜单拆成两套

参考项目在 `file-manager.tsx` 用 `node.isFolder ? FolderItem : FileItem` 分派两套完全独立的菜单；
0.5.5 本项目是单一菜单靠条件隐藏几项，导致文件右键也出现「新建文件夹 / 创建副本」，
文件夹右键却缺批量知识库动作。

本版 `src/components/FileTree.tsx` 按 `isFolder` 分成两个 JSX 分支，共用
`templateSubmenu` / `knowledgeSubmenu` / `clipboardItems` / `renameDelete` / `viewSwitches` 片段，
并给菜单加 `data-tree-kind="folder|file"` 便于回归定位。

| 文件夹右键 | 文件右键 |
| --- | --- |
| 新建文件 / 新建文件夹 | 在新窗口打开 |
| 展开 / 折叠 / 全部折叠 | 只读打开 |
| 查看目录 | 查看目录 |
| 从模板新建笔记 | 从模板新建笔记 |
| — | 导出（Markdown / HTML / JSON / PDF 子菜单） |
| — | 上传文件 |
| 知识库：计算文件夹下所有向量 / 删除文件夹下所有向量 / 全部重新计算 | 知识库：计算更新向量 / 删除向量 / 自动计算开关 / 包含在知识库中开关 / 全部重新计算 |
| 剪切 / 复制 / 创建副本 / 粘贴 | 剪切 / 复制 / 粘贴 |
| 上传文件夹 / 下载文件夹 | — |
| 重命名 F2 / 删除 Del | 重命名 F2 / 删除 Del |

配套新增能力：

- 后端 `fs/openExternal`（`fileops.rs`）：DBX 宿主只有单个 iframe，无法再开插件窗口，
  因此「在新窗口打开」等价映射为用系统默认程序打开该文件（Windows `cmd /C start`、
  macOS `open`、Linux `xdg-open`），路径仍经 `files::safe_join()` 校验。
- 「只读打开」：`useUiStore.readOnlyPaths` + `setReadOnly()`；
  `MarkdownEditor` 用 `editor.setEditable(false)`，`SourceEditor` 用 CodeMirror `editable={false}`，
  顶栏显示可点击的「只读」标记（点击退出只读），保存按钮禁用。
- 文件右键导出直接复用底栏的 `exportMarkdown(format, { path, markdown })`，正文从磁盘读。
- 单文件知识库两个开关通过 `kb/flags` 查询与写回。

## 3. PDF 导出不再保存 `print.html`

0.5.5 的 `printPdf()` 在 DBX 宿主 iframe 里被沙箱吞掉 `window.open()` / `iframe.print()` 后，
静默降级调用 `saveTextExport()` 保存 `*.print.html`，于是「点 PDF 却弹出保存 HTML 的另存为框」。

本版：

- 后端 `native.rs` 新增 `dialog/printHtml`（`native_stub.rs` 有同名非 Windows 桩）：
  Sidecar 把带自动 `window.print()` 脚本的预览页写到 `%TEMP%/dbx-note-print/`，
  再用系统默认浏览器打开，完全绕开插件沙箱；自动化环境
  （`DBX_NOTE_EXPORT_AUTO_DIR`）只落临时文件并返回 `opened:true`。
- `src/lib/markdownExport.ts` 的 `ExportOutcome` 新增 `message`；PDF 分支只调 `rpc.printHtml()`，
  **不再写任何 `*.print.html` 文件**；浏览器都拉不起来时返回可读提示。
- `EditorFooterBar.tsx` 对 `message` 用 `toast.error()` 明确报错，不再误报导出成功。
- i18n 的 PDF 提示与兜底文案同步改正。

## 4. 全局截图选区边框改红色

`backend/src/screenshot_ink.rs` 新增 `SELECTION_BORDER = cref(0xef_4444)`：
`FrameRect()` 的边框与 8 个 resize handle 的 `CreatePen()` 描边统一改用该常量；
工具栏、尺寸角标仍用中性 `FRAME`，避免整块 UI 被染红。
新增 Rust 单测校验常量值与「和工具栏颜色不同」。

---

## 5. 新增 / 修改的 RPC

| RPC | 参数 | 返回 |
| --- | --- | --- |
| `kb/vectorStatus` | — | 模型 / 来源数 / 分块数 / 维度 / 路径 / 参数 |
| `kb/indexFile` | `{ path, ...options }` | `{ indexed, chunks, skipped, updatedAt, failed }` |
| `kb/indexFolder` | `{ path, ...options }` | 同上 |
| `kb/reindexAll` | `{ ...options }` | 同上 |
| `kb/deleteVectors` | `{ path }` | `{ deleted }` |
| `kb/flags` | `{ path, autoCalc?, included? }` | `{ path, autoCalc, included }` |
| `kb/clear` | — | `{ cleared }` |
| `kb/search` | `{ query, topK?, threshold? }` | `{ items, context, sources, configured, tookMs }` |
| `kb/snapshotExport` | — | `{ json, path, count, vectorCount }` |
| `kb/snapshotImport` | `{ json? }` | `{ count, vectorCount, dimension }` |
| `dialog/printHtml` | `{ name, html }` | `{ opened, path?, auto?, unsupported?, message? }` |
| `fs/openExternal` | `{ path }` | `{ ok, path }` |
| 旧 `kb/status` / `reindex` / `upsert` / `export` / `import` | 同 0.5.5 | 兼容字段 |

## 6. 回归

| 项目 | 结果 |
| --- | --- |
| `cargo check` | 通过（仅 1 条既存 `native::shutdown` dead_code 警告） |
| `cargo test --bin backend` | **14 / 0**（9 条 RAG、2 条另存为路径、3 条 resize、1 条红色选区边框） |
| `npm run backend` | Windows release Sidecar 构建通过 |
| `npm run typecheck` | 0 错误 |
| `npm run build` | 5,770 模块，`ui/assets/index-*.js` 5,334 kB |
| `npm run sidecar-check` | **194 / 0**（全新数据目录 `.tmp/check-056`） |
| `npm run smoke` | **12 / 0** |
| `npm run e2e` | **320 / 3**，见下 |
| `preflight.mjs --dir .` | 通过（1 项未跟踪文件提醒，均为 target / .tmp 产物） |

e2e 的 3 条失败全部落在同步设置面板的既有时序敏感断言：
「可选择代码托管平台」「WebDAV 显示目录地址表单」「自托管显示服务地址表单」。
三轮完整回归中失败位置各不相同（第一轮 3 条在令牌提示 / WebDAV / RAG 面板，
第二轮 3 条在标签页 + git version，第三轮 3 条在同步平台表单），
属本机冷启动 + 并发构建负载导致的抖动，与本版改动无关；
本版新增的所有断言在三轮中均全通过：两套右键菜单及其互斥项、RAG 设置页参数与开关、
PDF 不写 `print.html`、对话面板知识库引用、导出四格式落盘、历史版本恢复。
已把其中 7 条固定 `waitForTimeout` 改成显式等待 / 轮询，剩余 3 条保留原样如实记录。

## 7. 已知边界

- 没有配置 embedding 模型时知识库只走 BM25，不会报「未配置」错误，
  设置页状态卡会显示「未配置嵌入模型」；配好后需点一次「全部重新计算」。
- 「在新窗口打开」受 DBX 单 iframe 限制，落地为系统默认程序的独立窗口，
  不是插件内的第二个编辑器标签。
- 快照以 JSON 存整个向量库；笔记很多时文件会比较大，由用户自行决定是否随云同步。
- `package-lock.json` 中仍有 121 条 `registry.npmmirror.com` 绝对 URL。CI attempt 1 有
  3 个 runner 因该镜像 504 超时导致 `npm ci` 失败；重跑失败 job 后 5 平台全绿。
  下个版本建议统一替换为 `registry.npmjs.org`（`integrity` 与下载域名无关，替换安全）。

## 8. 发布链路（v0.5.6）

| 项 | 值 |
| --- | --- |
| Release | https://github.com/mjj3610/dbx-note/releases/tag/v0.5.6 （非 draft） |
| CI run | https://github.com/mjj3610/dbx-note/actions/runs/42753418479 — attempt 2 **success**，5 平台 + publish |
| Release 资产 | 5 个 `.dbxp` + `release-candidates.json` |
| 商店候选 PR | https://github.com/t8y2/dbx-store/pull/493 — open，单文件 diff，等维护者 `/sign` |
| 旧候选 | #490（0.5.5）已关闭未合并，保证同一插件只有一个 open candidate |

候选 JSON 的 `sha256` / `size` 全部取自 CI 生成的 `release-candidates.json`；
`validate` 唯一错误 `awaiting DBX Store signing` 属签名前预期。
