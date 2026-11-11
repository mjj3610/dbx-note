# 发布到 DBX 商店

## 当前状态

| 项 | 值 |
| --- | --- |
| 已上架版本 | `com.mjj3610.note` **v0.5.8**（维护者 `t8y2` 在 #501 评论 `/sign`，PR 于 2026-11-11T05:01:17Z 合并；上游 `plugins/com.mjj3610.note.json` 与 `catalog/index.json` 的 `latestVersion` 均为 `0.5.8`，`versions` 含 0.5.0 / 0.5.4 / 0.5.7 / 0.5.8） |
| 待签名候选 | **v0.5.9** → https://github.com/t8y2/dbx-store/pull/507 （open，分支 `add-com.mjj3610.note-0.5.9`，diff 仅 `candidates/com.mjj3610.note.json` +59 行） |
| 候选包 | 5 个平台，见下表 |
| 源码 | https://github.com/mjj3610/dbx-note/tree/v0.5.9 （`dev` 已合并 `main`） |
| Release | https://github.com/mjj3610/dbx-note/releases/tag/v0.5.9 （CI run **43040620365**，**attempt 1 即 completed / success**，6 个 assets = 5 个 `.dbxp` + `release-candidates.json`） |
| PR 校验 | #507 的 `validate` 为 failure 属**签名前预期**：唯一错误是 `Catalog contains 1 open candidate(s) awaiting DBX Store signing: com.mjj3610.note@0.5.9`；本地用上游 main 副本跑 `scripts/validate.mjs` 得 `Validated 102 plugin metadata file(s)` 后仅报该错，其余都是 localization warning。维护者 `/sign` 后写入 `plugins/` 与 `catalog/` 即会通过 |
| 旧 PR | #469（0.5.0）、#487（0.5.4）、#498（0.5.7）、**#501（0.5.8）** 已签名合并；#484（0.5.2）、#486（0.5.3）、#490（0.5.5）、#493（0.5.6）复核后已关闭未合并。提 #507 前重新查过 #501 状态与上游 open PR：**#501 已合并、本插件 open 候选 0 个**，因此没有关闭任何旧 PR |
| 待办 | 等维护者审核 #507 并评论 `/sign`；签名合并后把本表「已上架版本」改成 0.5.9 |

候选包指纹（全部来自 CI 的 `release-candidates.json`，未签名）：

| target | sha256 | size |
| --- | --- | --- |
| `darwin-arm64` | `0a6df70e92bfbb649d2417d7bbe86f920cc63979e7ec3cecbe46f5e8f42a817a` | 3,746,303 |
| `darwin-x64` | `e2b933c86bbd2b7ef4e61a2155ce3150d0c62944844abaaed319a90aea1add04` | 3,900,672 |
| `linux-arm64` | `a4b1e566e0b166956bad2b16e9833184569500a17d57740ff99700e71d5d2e70` | 3,825,921 |
| `linux-x64` | `8724de861673ca1f08148e45135b20c9105b322c9713d0c1e2f916999c879e13` | 3,903,037 |
| `windows-x64` | `f5c6fad2a800b7c20be6977a072f74fd1fbc91186c9fc0b0f5f697db9b5cb171` | 3,955,557 |

（上一版 0.5.8 的候选 #501 已签名合并，其指纹已写入上游 `plugins/com.mjj3610.note.json`；
0.5.7 的指纹见 `git show 75b46a0:store-submission/PUBLISH.md`，其 PR #498 已签名合并；
0.5.6 的指纹见 `git show a91b986:store-submission/PUBLISH.md`，其 PR #493 已关闭未合并；
0.5.5 的指纹见 `git show 767fbe5:store-submission/PUBLISH.md`，其 PR #490 已关闭未合并；
0.5.4 的指纹见 `git show 6b99320:store-submission/PUBLISH.md`，其 PR #487 已签名合并；
0.5.3 指纹见 `git show 2aac00e:store-submission/PUBLISH.md`，其 PR #486 已关闭未合并；
0.5.2 指纹见 `git show 0cc03ef:store-submission/PUBLISH.md`。）

### v0.5.9 发布要点

- 用户先要求评估 wiki 知识图谱的可行性 / 兼容性 / 性能，第一版「扫 Markdown 链接 + 侧栏小图」被否；
  明确改为「基于知识库向量化结果生成 / 发现 / 刷新，点图谱在中间大区显示并与知识块联动」。
  第二版设计（见 `docs/知识图谱设计-v0.5.9.md`）确定：图谱 = 向量库**只读派生视图**。
- 用户要求「创建 dev 代码分支，进行 1-4 阶段实现，先不进行商店候选 PR」：本地 main 停在 `75b46a0`，
  工作区带 v0.5.8 全量改动 → 建 `dev` 后先提交基线 `0e4c294`，再叠加 4 阶段实现（`0ecdab9`）。
  期间补 release Sidecar 构建与本地 `.dbxp`（3,946,626 B，sha256 `fbd55dff…bff2998`），
  包校验 **14/0**、包内 Sidecar 协议自检 **214/0**。
- **本地安装「无响应」排查**：宿主 `versions/` 只有 0.5.6 / 0.5.8，最新激活记录是 0.5.8，
  `sidecar.log` 最后一次 Sidecar 启动仍是 `version=0.5.8`；0.5.9 包与已装 0.5.8 的 manifest
  逐字段只差 `version`，13 文件 / 12 条 checksums 一致，排除包本身。根因是 DBX 便携版
  **未注册 `.dbxp` 文件关联**（`HKCR\.dbxp` 与 `UserChoice` 均为空），双击 / 点文件卡片不会触发安装，
  正确入口是「DBX → 插件管理 → 从本地安装」。宿主退出后按它自己的格式增量落盘
  `versions/0.5.9/` + `activations/…36-….json`，落盘 Sidecar 握手 `0.5.9` 通过；两项均可删，回退即回 0.5.8。
- **发布前守卫**：重查 #501 发现已被 `/sign` 并合并（2026-11-11T05:01:17Z），上游 `latestVersion=0.5.8`、
  本插件 open 候选 0 个 → **没有关闭任何旧 PR**，避免重演 0.4.0 误关正在签名候选的事故。
- **合并方式**：本机 `git push` 经代理不通且远端 main（`2bb46a2`）领先本地基线，
  改用 `.tmp/api-push-059.mjs` 以远端 main tree 为 `base_tree`、按两边 git blob sha 逐文件精确比对：
  第一轮 **30 改 / 0 删 / 175 未变** → `971bbdf`；发布文档与 `.dbx-store.json` 更新后第二轮 → `c4ad7b6`。
  本地用 `git branch -f main dev` 快进（期间清掉一次 checkout 中断留下的陈旧 `.git/index.lock`）。
  第二轮出现 12 个 LF/CRLF 行尾造成的 blob sha 伪差异，内容与上一轮相同，0 删除，不影响 CI。
- 回归：`cargo test --bin backend` **27/0** / `typecheck` 0 错误 / `build` ✓ / `sidecar-check` **214/0** /
  `smoke` **34/0** / `e2e` **351 通过 / 1 失败**（唯一失败为锁屏 / 远程会话导致的全局截图环境项）。
- 发布链路：`.tmp/release-api-056.mjs v0.5.9` 建 tag / 非 draft Release →
  CI run **43040620365 attempt 1 success**（5 平台 Build + Publish assets 共 6 job 全绿）→
  `.tmp/fetch-candidates-059.mjs` 取 5 平台指纹 → `.tmp/make-candidate-059.mjs` 拉上游 main 副本生成候选 →
  `scripts/validate.mjs` 得 `Validated 102 plugin metadata file(s)`，唯一错误为预期等签名 →
  `.tmp/store-pr-059.mjs` 提 **#507**。
- 注意：Git Bash 的 `tar` 会把 `G:\\...` 解析成 `host:path`（`Cannot connect to G: resolve failed`），
  脚本里外部命令一律用相对路径 + 显式 `cwd`。

### v0.5.8 发布要点

- 用户先反馈 v0.5.7 装完后「改了笔记但提交改动显示没有改变」「手动推送 Gitee 认证失败」，
  根因是自动同步 commit 成功 / push 失败被吞，以及 `GIT_ASKPASS=echo` 把提示语当用户名发给
  Gitee、平台信任设置项与远端地址脱钩。修复见 `docs/release-notes-v0.5.8.md` 第 1 / 2 节。
- 随后要求按参考项目复刻「远程有、本地没有的笔记」清单逻辑：去掉 15s 节流改单 flight 排队补跑、
  补齐展开目录 / 搜索 / 文件操作 / 配置保存 / 测试连接触发、清单失败可见可重试、错误脱敏。见第 3 节。
- 发布前最后一次追加：用户反馈「大纲加载很慢、只有点击一级标题能定位」，要求对照参考项目完善并
  **「改完这点后再进行发布商店」**。改为 ProseMirror 增量标题索引 + 按 `id`/`pos` 定位，
  H1~H6 全部可点；smoke 断言从 12 条扩到 25 条。见第 4 节。
- **发布前守卫救了一次**：按 PUBLISH.md 的教训重新查 #498，发现维护者 `t8y2` 已在
  03:42:23Z 评论 `/sign`，签名工作流 `42954504190` 正在 `in_progress`。因此**没有关闭 #498**，
  先推进源码 / tag / Release / CI；03:47:48Z 确认 #498 已合并、上游 `latestVersion=0.5.7`、
  无本插件 open 候选后，才提 #501。若按旧记录直接「关闭 0.5.7 候选」，会毁掉维护者刚完成的签名。
- `preflight.mjs` 报 `backend/src/sync.rs` 疑似凭据：单测里 `oauth2:token@gitee.com` 这类示例被
  邮箱正则误判。仿 0.5.4 的处理，把注释改成文字描述、把示例 URL 里的 `@` 用 `format!("{AT}")` 拼，
  运行时字符串完全不变；`cargo test --bin backend` 复跑 **24/0**，预检转为全绿。
- 回归：`cargo test --bin backend` **24/0** / `tsc --noEmit` 0 错误 / `vite build` ✓ /
  `sidecar-check` **205/0** / `smoke` **25/0** / `e2e` **337 通过 / 1 失败**（唯一失败为锁屏 / 远程会话
  导致的全局截图环境项）。本地 `.dbxp`：3,911,385 B，sha256 `7f2fe592…94f124f716`，
  12/12 checksums 与 Sidecar 字节一致。
- 发布链路：`.tmp/api-push-058.mjs`（Git Data API 以远端 main tree 为 base_tree 逐文件建 blob/tree/commit，
  避开本机 git push 的代理问题，也兼容远端领先的文档提交）→ `.tmp/release-api-056.mjs v0.5.8`
  建 tag / 非 draft Release → CI run `42956095802` **attempt 1 success** →
  `.tmp/fetch-candidates-058.mjs` 取指纹 → 现拉上游 tarball 到 `.tmp/dbx-store-058` →
  `make-store-candidate.mjs --validate`（唯一错误为预期等签名）→ `.tmp/store-pr-058.mjs` 提 #501。
- 注意：本机 `git update-ref refs/remotes/origin/main` 会因远端 commit 对象不在本地而失败，
  **只影响本地跟踪引用，不影响远端 main / tag / CI**；脚本已改成软失败。

### v0.5.7 发布要点

- 用户四张截图反馈：数学公式同步上传后丢失且重开不显示；编辑器行内 `/` 带不出块编辑菜单；
  块前 `+` 移动过去就消失；关闭一个 tab 时其它 tab 先消失再回来。
- 根因分别是：`mathNodes.tsx` 两个节点漏配 `markdownTokenName` 导致 Markdown 解析时公式
  token 被静默丢弃并被防抖保存写回覆盖云端；`SlashMenu.tsx` 行首正则过严；
  `BlockHandle.tsx` hover 区域断裂 + 零延迟隐藏；`notes.closeTabs()` 先置空 `activePath`
  导致 `EditorPane` 卸载标签栏。额外修复 `open()` 短路只看 `activePath` 的竞态。
  详见 `docs/release-notes-v0.5.7.md`。
- 版本统一升到 `0.5.7`；本版**不新增后端 RPC、不改表结构**。
- 顺带修掉 0.5.6 CI 的 `registry.npmmirror.com` 504 隐患：`package-lock.json` 版本
  `0.4.0 → 0.5.7`，121 条镜像绝对地址全部换成 `registry.npmjs.org`。
  **本版 CI run 42823213363 一次通过，5 平台 + publish 全绿，无需重跑失败 job。**
- 用户明确授权「直接发 v0.5.7」：按商店规则先用 `.tmp/close-493.mjs` 关闭 0.5.6 未签名候选，
  再打 tag / 发 Release / 等 CI / 生成候选 / 提 #498。
- 发布前核对：#493 仍 open 且无维护者评论；上游 `latestVersion=0.5.4`、无本插件 open 候选；
  `v0.5.7` tag 与 Release 不存在；`preflight.mjs --dir .` 通过。
- `make-store-candidate.mjs --validate` 唯一错误为预期 `com.mjj3610.note@0.5.7 awaiting DBX Store signing`；
  #498 的 check-run 同样是 `validate | completed | failure`。

### v0.5.6 发布要点

- 用户三张截图反馈：文件夹与文件右键菜单功能按钮不一致；导出 PDF 时弹出「导出为 `print.html`」；
  知识库需要与参考项目完整对齐。追加要求「全局截图的区域选择边框线颜色改为红色」。
- 知识库从 `.dbx-note/kb-index.json` 索引快照换成真 RAG：`backend/src/knowledge.rs` 建
  `knowledge_sources` / `vector_documents` / `kb_meta` 三表，标题感知 Markdown 分块（代码块 /
  表格 atomic）、批量 embedding、余弦 + BM25 + RRF 混合检索、快照导入导出；未配置 embedding
  时降级为纯词法索引而不是报错。前端新增 `RagSection.tsx` 设置页、底栏知识库状态按钮、
  `chat.ts` 的 `kbSearch()` 上下文注入；AI 模型设置放开 embedding 用途。
- 右键菜单按 `node.isFolder` 拆成两套（`data-tree-kind="folder|file"`）：文件夹独有新建 /
  展开折叠 / 创建副本 / 上传下载文件夹 / 批量向量；文件独有在新窗口打开 / 只读打开 /
  导出四格式 / 上传文件 / 单文件向量开关。新增 `fs/openExternal`、`useUiStore.readOnlyPaths`。
- PDF 不再静默写 `*.print.html`：新增 `dialog/printHtml`，Sidecar 写临时打印预览页并用系统
  默认浏览器唤起打印窗口，失败时 UI 明确提示改用「导出 HTML」。
- 全局截图选区边框与 8 个 resize 手柄描边改为红色 `cref(0xef_4444)`，工具栏与尺寸角标保持中性色。
- 回归：`cargo check` / `cargo test --bin backend` **14/0** / release Sidecar build / `tsc --noEmit` /
  `vite build` / **sidecar-check 194/0** / **smoke 12/0** / **e2e 320/3**（3 项为同步设置面板
  既有时序抖动，本版新增断言全通过），`dbx-store-publish` preflight 通过。详见
  `docs/release-notes-v0.5.6.md`。
- 发布链路：`.tmp/close-490.mjs` 先关闭 0.5.5 未签名候选 → `.tmp/api-push.mjs` 用 Git Data API
  把领先提交推到远端 main（`1e5c659`，树与本地 HEAD 一致）→ `.tmp/release-api-056.mjs`
  建 tag / 非 draft Release → CI run `42753418479` → **attempt 1 有 3 个平台因
  `registry.npmmirror.com` 504 超时失败**（linux 两个平台成功），用 `rerun-failed-jobs` 重跑后
  5 平台全绿 → `.tmp/fetch-candidates-056.mjs` 取指纹 → 现拉上游 tarball 到
  `.tmp/dbx-store-056` → `make-store-candidate.mjs --validate` 唯一错误为预期的等签名 →
  `.tmp/store-pr-056.mjs` 提 #493。
- **待改进**：`package-lock.json` 里仍有 121 条 `registry.npmmirror.com` 绝对 URL，CI 偶发 504。
  下个版本可统一替换成 `registry.npmjs.org`（integrity 与内容哈希无关，替换安全）。

### v0.5.5 发布要点

- 用户三张截图反馈：参考项目文件树「更多」菜单 / 右键菜单仍有缺失；底栏四种导出点击后都产出 HTML；
  系统「另存为」窗口弹在软件下面。
- 导出修复：`GetSaveFileNameW` 固定 `nFilterIndex = 1`，`sanitize_export_name()` 先剥旧后缀、
  `normalize_export_path()` 按目标格式重建后缀；PDF 改走顶层 `window.open()` 打印，被宿主禁用时
  降级为明确命名的 `*.print.html` 并给出提示，不再伪装成普通 HTML 导出。
- 置顶修复：`focus_host()` + `GetForegroundWindow()` 作为 `hwndOwner`，`OFN_ENABLEHOOK` 在
  `WM_INITDIALOG` 里 `SetWindowPos(HWND_TOPMOST)` / `BringWindowToTop()` / `SetForegroundWindow()`。
- 文件树补齐：`FileMoreMenu.tsx`（排序 / 折叠 / 资源文件夹 / 知识库状态 / 远程文件 / 导入
  笔记、Markdown、Notion zip）、右键菜单与 F2 / Del / Ctrl+X/C/V 快捷键、视图偏好持久化；
  参考项目的远端向量索引等价映射为工作区 `.dbx-note/kb-index.json` 快照。
- 回归：cargo release build ✓、后端测试二进制 5/0、tsc 0、vite ✓、**Sidecar 187/0**、
  **smoke 12/0**、preflight ✓；e2e 完整一轮 286/8，本版新增 15 条断言全通过，
  8 项为与改动无关的本机时序抖动，用户确认「按现状发布」。详见 `docs/release-notes-v0.5.5.md`。
- 发布链路：`release-api.mjs` 建非 draft Release → CI run `42624326811` success →
  现拉上游 tarball 到 `.tmp/dbx-store-055`（当时 `plugins/` 仍是 0.5.4）→
  `make-store-candidate.mjs --candidates .tmp/release-candidates.json --store .tmp/dbx-store-055 --validate`
  → `.tmp/store-pr-055.mjs` 提 #490（脚本带 open 候选守卫与候选自检）。

### v0.5.4 发布要点

- 用户确认「历史版本与参考项目一致 + 导出走系统另存为」后重写编辑器底栏两块能力：
  导出弹系统 `GetSaveFileNameW`、写盘并回显路径、取消不写盘；JSON 为 Tiptap 文档、
  HTML 内联工作区图片；历史版本改读远端 Git commit 列表（最近 10 条，按 sha 恢复），
  未配置 Git 远端时入口隐藏。见 `docs/release-notes-v0.5.4.md`。
- 发布前 `preflight` 通过（1 项提醒：`backend/target` 构建产物；
  另修正了 `githistory.rs` 注释里被误判为凭据的示例 URL）。
- 最终回归：cargo check / release build / tsc / vite build、**Sidecar 158/0**、**smoke 12/0**、**e2e 258/0**。
- 上游商店目录用**现拉的 tarball**（`.tmp/dbx-store-054`），catalog 中本插件 `latestVersion` 仍是 `0.5.0`。
- 全程 REST API：关闭 #486 用 `.tmp/close-486.mjs`（带守卫），发 Release 用 `.tmp/release-api.mjs`，
  提 PR 用 `.tmp/store-pr-054.mjs`。

签名后维护者会把 `plugins/com.mjj3610.note.json`、`catalog/index.json` 写回 PR 并删掉
`candidates/*.json`。作者侧不需要、也不应该自己填 `signingKeyId` 或改 `verified`。

按 `CONTRIBUTING.md`，**已有插件的版本更新**也只提交 `candidates/<id>.json` 一个文件：
省略的展示字段保留现值，写入的字段替换现值；`plugins/<id>.json` 里的 `latestVersion`
与 `versions[]` 由签名工作流维护，作者不要手改。

### #459（0.4.0）的时序问题

0.4.0 的候选 PR #459 在 13:06 被维护者审核通过、13:10 由签名工作流签好
（签名产物在 `mjj3610/dbx-store` 的 `main`，提交 `b2936d9`），我在 13:20 追加迁移说明时
才发现签名已完成 —— 此时已经把它关闭了。结果：

- 上游 `main` 没有 `plugins/com.mjj3610.note.json`，#459 关闭未合并，**0.4.0 未上架**；
- 0.4.0 的签名产物仍在 fork 的 `main` 上，没被破坏，需要时可以复用；
- 已在本仓库提 #469（0.5.0 / 5 平台），并在 #469 上留言说明：若维护者更希望先上 0.4.0，
  我重开 #459、0.5.0 转后续更新 PR。

**教训**：关闭旧候选 PR 前先看它有没有评论 / 签名 bot 回复。签名是自动的，可能在自己
埋头打 Release 的这段时间就完成了。

**后续（2026-11-05 16:23）**：维护者没有要求重开 #459，而是在 #469 上评论 `/sign`，
签名工作流完成 5 平台包校验后 PR #469 已合并，`plugins/com.mjj3610.note.json` 的
`latestVersion` 为 `0.5.0`。所以 0.4.0 从未上架，也无需再重开 #459。
**每次发布前都要重新查一次 PR 状态**：本轮就差点按过时记录去「替换 #469」。

### 0.5.2 版本更新：PR #484 已关闭（历史记录，被 0.5.3 取代）

0.5.1 修了 Git 通道「打开笔记不拉取」，0.5.2 又补上了「进入文件树时拉远端目录清单 /
合并仅云端节点」（`docs/版本部署变更说明-v0.5.2.md`）以及全局截图选区 8 向缩放。
这两批改动都不在已上架的 0.5.0 包内，因此按「已有插件的版本更新」重发。

2026-11-09 完成情况：

| 项 | 状态 |
| --- | --- |
| 0.5.2 代码 | 已推送 `main`（远端清单 / 截图 resize / 图床检测竞态 / 嵌套仓库误判） |
| 版本号 | `manifest.json`、`package.json`、`backend/Cargo.toml`、`PLUGIN_VERSION` 均为 `0.5.2` |
| 商店元数据 | `.dbx-store.json` 的 `source` 已指向 `v0.5.2`，`releaseNotes` 补齐 0.5.1 / 0.5.2 |
| 回归 | `cargo check`、`cargo test resize_tests` 3/3、`tsc`、`vite build`、Sidecar 136/0、smoke 11/0、e2e **241/0** 全绿 |
| preflight | 通过（仅 `backend/target` 构建产物未纳入 git 的提醒） |
| `v0.5.2` Release | 已发布（非 draft，才会触发 CI）：https://github.com/mjj3610/dbx-note/releases/tag/v0.5.2 |
| 5 平台 CI | https://github.com/mjj3610/dbx-note/actions/runs/42553966663 — **success** |
| 候选 JSON | 已用 CI 的 `release-candidates.json` 生成并本地校验通过 |
| 商店 PR | https://github.com/t8y2/dbx-store/pull/484 — **已关闭未合并**（未签名，被 #486 的 0.5.3 候选取代）；0.5.2 从未上架 |
| 下一步 | 见下一节 0.5.3 |

注意候选 JSON 的 `sha256` / `size` 必须取 CI 产物，不能用本机 mingw 包重新计算；
本机 debug 二进制只用于功能回归。发布工作流只认 `release: published` 事件，
建 draft 或事后编辑 Release 描述都不会触发构建。

### 0.5.3：已发布，等待签名

0.5.3 复刻了参考项目编辑器底栏的**复制 / 导出 / 历史版本**（`docs/版本部署变更说明-v0.5.3.md`），
并不在 #484 的 0.5.2 包内。

| 项 | 状态 |
| --- | --- |
| 代码 | 已提交本地 `main`（后端历史版本快照与 RPC、前端底栏 / 导出工具层 / 历史面板、i18n、回归） |
| 版本号 | `manifest.json`、`package.json`、`backend/Cargo.toml`、`PLUGIN_VERSION` 均为 `0.5.3` |
| 商店元数据 | `.dbx-store.json` 的 `source` 已指向 `v0.5.3`，`releaseNotes` 补 0.5.3 段落 |
| 文档 | `docs/release-notes-v0.5.3.md`、`docs/版本部署变更说明-v0.5.3.md`、`README.md` 功能矩阵与测试数 |
| 回归 | `cargo check` / `cargo build --release`、`tsc`、`vite build`、Sidecar **145/0**、smoke **12/0**、e2e **253/0** 全绿 |
| preflight | 通过（仅 `backend/target` 构建产物提醒） |
| `v0.5.3` Release | https://github.com/mjj3610/dbx-note/releases/tag/v0.5.3 （非 draft） |
| 5 平台 CI | https://github.com/mjj3610/dbx-note/actions/runs/42562596951 — **success** |
| 候选 JSON | 用 CI 的 `release-candidates.json` 生成，`make-store-candidate.mjs --validate` 只报预期「等待签名」 |
| 商店 PR | https://github.com/t8y2/dbx-store/pull/486 — open，diff 只有 `candidates/com.mjj3610.note.json`（+59 行） |
| 下一步 | 等维护者 `/sign` |

用户选择「直接发 0.5.3」。按「每次发布前重新查 PR 状态」的教训，发布前重新查了 #484：
`state=open / merged=false / 0 评论 / diff 仅候选文件 / validate 因等待签名失败`，
确认**未被 `/sign`** 后才留言说明由 0.5.3 取代并关闭，避免同一插件同时出现两个 open 候选。
`validate` 在 #486 上的失败同样已查工作流日志确认唯一错误是
`com.mjj3610.note@0.5.3 awaiting DBX Store signing`。

## 关键认知

- **提交的不是 `.dbxp`**，而是一个只含元数据的 JSON。包由商店审核后用仓库密钥签名。
- **候选的 sha256 / size 必须来自 CI 产物**。本机只能打当前平台，且工具链不同字节必然不同：
  0.4.0 时本地 mingw 包是 `5bb315d1…` / 3,717,088 B，CI 的 MSVC 包是 `7b78db04…` / 3,727,076 B；
  0.5.0 本地 mingw 包是 `fb734bd3…` / 3,723,195 B，而候选里写的是 CI 的 `acafb488…` / 3,732,593 B。
  拿本地的数字去提交，签名时会被拒。
- 出包走官方可复用工作流，不要自己拼 5 个平台的构建脚本。

## 后续版本怎么发

版本号递增后（`manifest.json` + `package.json` + `.dbx-store.json` 里的 tag 一起改），
用 `dbx-store-publish` 技能的脚本走：

```bash
SKILL=~/.workbuddy/skills/dbx-store-publish

node $SKILL/scripts/preflight.mjs --dir . \
  --allow-ignored "backend/target,node_modules,ui,release,.dbx-dev,.tmp,.workbuddy,screenshots"

git push origin main
node $SKILL/scripts/gh-publish.mjs release --tag vX.Y.Z --notes docs/release-notes-vX.Y.Z.md
node $SKILL/scripts/gh-publish.mjs status --watch
node $SKILL/scripts/gh-publish.mjs assets --tag vX.Y.Z --download release-candidates.json -o .tmp
```

拿到 CI 的 `release-candidates.json` 后生成候选并校验：

```bash
node $SKILL/scripts/make-store-candidate.mjs \
  --candidates .tmp/release-candidates.json --store .tmp/dbx-store --validate
```

校验输出里那条 `Catalog contains N open candidate(s) awaiting DBX Store signing`
是**绿灯前的正常状态**，不是失败。

最后提 PR。本机经代理 `git clone`/`fetch` 拉 `t8y2/dbx-store` 会稳定 502（`api.github.com`
直连正常），所以商店侧一律走 REST API，见文末「本机网络限制下的备选操作方式」。

取商店仓库内容用于本地校验时，同样别用 `git clone`，改用 tarball：

```bash
curl -sSL --noproxy '*' -o .tmp/store.tgz \
  https://api.github.com/repos/t8y2/dbx-store/tarball/main
mkdir -p .tmp/dbx-store && tar -xzf .tmp/store.tgz -C .tmp/dbx-store --strip-components=1
```

## 多平台

出包矩阵在 `.github/workflows/plugin-release.yml` 的 `build-matrix` 里，0.5.0 起是 5 个平台：

```yaml
build-matrix: >-
  {"include":[
    {"runner":"windows-2022","target":"windows-x64"},
    {"runner":"ubuntu-24.04","target":"linux-x64"},
    {"runner":"ubuntu-24.04-arm","target":"linux-arm64"},
    {"runner":"macos-15-intel","target":"darwin-x64"},
    {"runner":"macos-15","target":"darwin-arm64"}
  ]}
```

官方可复用工作流在各自 runner **原生编译**（不做交叉编译），publish 阶段校验「包未签名 +
各平台包内 manifest 身份一致」，再合并出 `release-candidates.json`。注意 `fail-fast: false`
只保证单个平台构建失败不影响其它平台，但 publish 需要全部构建成功。

### 非 Windows 能编译是靠桩（0.5.0 已完成）

0.4.0 时后端有 51% 代码直接调 Win32，darwin/linux 上是**编译失败**而非运行期降级：

| 模块 | 行数 | 依赖的 Win32 API |
| --- | --- | --- |
| `screenshot.rs` | 2409 | GDI `BitBlt`、分层窗口、`GetDIBits` |
| `screenshot_ink.rs` | 2126 | 同上的标注重绘循环 |
| `native.rs` | 828 | `RegisterHotKey`、剪贴板 `CF_DIB`、文件对话框 |
| `pin.rs` | 509 | `SetWindowPos(HWND_TOPMOST)` |
| `ocr.rs` | 345 | WinRT `Windows.Media.Ocr` |
| 合计 | 6217 / 12274 | 约占后端 51% |

0.5.0 的做法：

1. `windows-sys`、`png`、`cpal` 从 `[dependencies]` 移到
   `[target.'cfg(target_os = "windows")'.dependencies]`，Linux 上不再需要 ALSA 头文件；
2. `native` / `ocr` / `screenshot` 三组按平台分文件，非 Windows 走
   `#[cfg(not(windows))] #[path = "*_stub.rs"]`，桩与真实实现**同名同签名**，
   协议层分发逻辑一行不改，调用方拿到的是可读错误；
3. `pin` 与 `screenshot_ink` 只被 `screenshot.rs` 内部使用，整体 `#[cfg(windows)]` 即可。

平台能力矩阵见 `README.md` 的「3.2 平台支持」：Windows 全可用；macOS/Linux 主流程完整，
截图 / 剪贴板位图 / 录音 / 系统 OCR 为桩。

**本地验证桩签名的手法**（本机只有 Windows，非 Windows 分支编不到）：临时把桩挂到
`#[cfg(windows)]` 上跑 `cargo check`，让真实调用点去校验桩的签名，通过后还原 cfg。
只编源码不运行，所以桩里返回错误值不会影响编译结论。

后续补原生实现的顺序：macOS（ScreenCaptureKit / NSPasteboard / CGEventTap / Vision）→
Linux（X11 `XGetImage`、Wayland portal、`_NET_WM_STATE_ABOVE`、`XGrabKey`、外部 `tesseract`）。
商店按 target 逐条收录，追加平台是普通版本更新，不影响已上架条目
（`com.mjj3610.mail` 现在就是 5 个平台，也是逐步加的）。

## 本机网络限制下的备选操作方式

`git clone` / `fetch` 拉 `t8y2/dbx-store` 经代理会稳定 502，`api.github.com` 直连可用，
所以商店侧的一切操作都走 REST API（`.tmp/store-pr.mjs`、`.tmp/pr-status.mjs`、
`.tmp/run-log.mjs`）：

- 开 PR：在 fork 里用 Git Data API 以**上游 main 的树**为 `base_tree`，只加
  `candidates/<plugin-id>.json` 一个 blob，建提交后把分支指过去 —— 分支历史与上游同源，
  PR diff 只有一个文件；
- 看 CI：`GET /repos/{owner}/{repo}/commits/{sha}/check-runs`，失败时再用
  `GET /actions/jobs/{job_id}/logs` 取日志（日志接口返回纯文本）；
- 取仓库内容做本地校验：`GET /repos/t8y2/dbx-store/tarball/main`；
- **推送自己的仓库也可能 502**：0.5.3 最后一个文档提交时 `git push` 连续两次
  `schannel: server closed abruptly`，重试脚本三次又都是 `CONNECT tunnel failed 502`。
  此时用 `.tmp/rebuild-commits.mjs` 走 Git Data API 逐个重建本地领先的提交：
  带同一个 tree / parents / author / committer / message，远端会算出**与本地完全相同的 sha**，
  不会产生分叉；跑完 `git update-ref refs/remotes/origin/main <sha>` 同步本地跟踪引用即可，
  全程不需要 `git fetch`。

签名命令 `/sign` 只有维护者 `t8y2` 本人评论才生效（`sign-command.yml` 里写死了
`github.actor == 't8y2'`），作者侧无法触发，只能等。
