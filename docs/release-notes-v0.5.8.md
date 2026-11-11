# v0.5.8 — Git/Gitee 同步认证修复 + 「没有需要提交的改动」可解释化

本版处理 v0.5.7 安装后用户反馈的两个现象：

1. 「笔记已经做了修改，但是提交改动显示没有任何改变，自动同步也进行」
2. 「手动推送还报错」——`Incorrect username or password (access token)` /
   `Authentication failed for 'https://gitee.com/mjj3610/dbx-notegen.git/'`

参考实现为 `/g/workspace/note-gen-note-gen-v0.39.2`。

---

## 1. 「提交改动」为什么说没有改动

### 根因：改动已经被自动同步提交，但推送失败被静默吞掉

`src/lib/autoSync.ts` 的 `flush('git')` 在每次保存后（默认 5 秒防抖）依次调用：

```
syncCommit('')  →  syncPush()
```

所以用户打开「设置 → 同步」再点「提交改动」时，改动**已经在本地仓库里是一个 commit**，
`git add -A` 后 `git status --porcelain=v1` 自然为空，后端只能返回
`committed: false / 没有需要提交的改动`。

真正没成功的是下一步 `syncPush()`：Gitee 认证失败抛错，被 `flush()` 里的 `catch {}`
完全吞掉。于是形成用户看到的组合：

| 用户动作 | 实际发生 | 用户看到 |
| --- | --- | --- |
| 编辑并保存笔记 | 写盘成功 | 编辑器显示「已保存」 |
| 5 秒后自动同步 | commit 成功、push 认证失败且被吞 | 「自动同步进行过」，无任何提示 |
| 手动点「提交改动」 | 工作区已干净 | 「没有需要提交的改动」 |
| 手动点「推送」 | 带错凭据推送 | Gitee 认证失败 |

另外两个会让「明明改了却检测不到」的隐患也一并确认：

- `commit()` 原先**没有校验工作区自己是 Git 仓库根**。工作区落在其它仓库子目录时，
  `git -C <root> add -A` 会把外层仓库的改动一起暂存，数据归属错误；
- 笔记文件被 `.gitignore` 排除时，`git add -A` 不会纳入，同样表现为「没有改动」。

### 本版修复

| 位置 | 变更 |
| --- | --- |
| `backend/src/sync.rs::require_repo()` | 新增仓库根校验，`commit` / `pull` / `push` / `check` 统一前置，避免误操作外层仓库 |
| `backend/src/sync.rs::commit()` | 空改动时区分三种 `reason`：`clean`（真的没改动）、`unpushed`（已被自动同步提交但还有 N 个提交未推送）、`ignored`（笔记被 .gitignore 排除，列出文件） |
| `backend/src/sync.rs::record_failure/record_success()` | 最近一次成功 / 失败写入 `settings` 的 `app.sync.state`，`sync/status` 带回展示 |
| `backend/src/sync.rs::status()` | 新增 `effectiveProvider` / `authUsername` / `maskedToken` / `ignored[]` / `lastError` / `lastErrorAt` / `lastSuccessAt` |
| `src/components/dialogs/SettingsSync.tsx` | 「无改动」按级别提示（clean 成功、其它 warning）；状态卡片显示生效平台、被忽略文件、上次同步失败原文 |
| `src/lib/autoSync.ts` | 失败不再完全静默：写结构化 `console.warn`、派发 `dbx:sync-error` 事件、认证类错误每 2 分钟最多弹一次提示 |

---

## 2. Gitee 推送认证失败

### 根因 A：`GIT_ASKPASS=echo` 把提示语当成用户名提交给了 Gitee

`apply_git_env()` 原本设置了：

```rust
.env("GIT_ASKPASS", "echo")
.env("SSH_ASKPASS", "echo")
```

初衷是「没有凭据时不要卡在交互输入」，但 git 在无凭据时会执行
`echo "Username for 'https://gitee.com': "`，把**提示语本身**当作用户名，
密码同理，然后发出一次注定失败的请求。

Gitee 的错误格式是 `[session-xxx] <用户名>: Incorrect username or password (access token)`，
于是用户截图里出现的是：

```
remote: [session-8a4d5288] Username for 'https: Incorrect username or password (access token)
fatal: Authentication failed for 'https://gitee.com/mjj3610/dbx-notegen.git/'
```

即 Gitee 把 `Username for 'https://gitee.com': ` 这段提示语回显出来（在 `:` 处被截断）。
本版移除两个 ASKPASS 变量，只保留 `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never`：
有本机凭据就正常用，没有就快速失败并给出可行动的提示。

### 根因 B：平台完全信任设置项，与远端地址脱钩

`authorized_url()` 只按保存的 `provider` 拼用户名，默认是 `github`。用户只填了
`https://gitee.com/...` 而没有在平台列表里点「Gitee」时，会拼出：

```
https://x-access-token:<token>@gitee.com/...
```

GitHub 的 `x-access-token` 对 Gitee 私人令牌不适用。本版新增
`provider_for_url()`，按远端主机判定生效平台（gitee.com / github.com / gitlab.com），
自建域名才回退到用户选择的平台；`githistory.rs` 与 `gitsync.rs::listRemote`
也改为按地址判定，历史版本入口不再因平台选项没切而失效。

### 根因 C：重试分支把凭据丢了

`push()` 遇到非快进时，合并与重试写死 `origin`：

```rust
git pull ... "origin" <branch>
git push "origin" <branch>
```

而首次推送用的是带令牌的临时 URL。于是「第一次认证成功、重试却认证失败」或反之。
本版把 `used_target` 贯穿整个重试链路，`pull()` / `fetch_snapshot()` 也统一走同一套认证计划。

### 根因 D：令牌边界情况未处理

- 令牌含 `+ / = @ : #` 等字符时未做 URL 编码，地址会被切坏；
- 用户若把界面上的掩码 `d350••••1c` 误粘回输入框，会被当成真令牌保存；
- Gitee 私人令牌对用户名敏感，官方允许「账号名 / oauth2 / gitee.com」三种写法，
  不同时期生成的令牌表现不一致。

本版统一处理：

| 能力 | 实现 |
| --- | --- |
| URL 编码 | `urlencode()` 对用户名与令牌做百分号编码 |
| 掩码识别 | `looks_masked()` 命中 `•` / `*` / `…` 时拒绝作为凭据，界面标红提示重新粘贴 |
| 已有 userinfo | `build_authorized_url()` 去掉 origin 里旧的 `user:pass@`，避免拼出两段 |
| Gitee 多候选 | `auth_plan()` 生成「自定义账号名 → oauth2 → 仓库 owner」候选，仅认证失败时依次重试 |
| 凭据打码 | `sanitize()` 覆盖明文与编码后的令牌，错误信息不泄露凭据 |
| 友好报错 | `friendly_auth_error()` 把 git 原始报错翻译成「令牌过期 / 权限不足 / 平台不匹配」并给出下一步 |

### 新增能力：测试连接

`sync/check` 用与推送完全相同的认证计划执行一次 `git ls-remote --heads`，
在设置页点「测试连接」即可确认令牌、平台、远端地址是否匹配，返回生效平台与用户名；
Gitee 平台额外提供可选的「Gitee 账号名」输入框。

---

## 3. 追加：云端文件清单与参考项目严格对齐

用户追问「远程有的笔记文件本地没有，什么时间自动拉取、会不会自动拉取」，并要求按
参考项目 `note-gen v0.39.2` 复刻该部分功能。核对结论：两层语义与参考项目一致
（**清单自动拉、正文按需下载**），但触发时机、时间节流、失败可见性三处有偏差，本版逐项对齐。

### 3.1 触发时机：去掉 15 秒时间节流

参考项目 `loadRemoteSyncFiles()` 没有时间节流：进入文件页、展开目录、搜索、
新建 / 重命名 / 删除 / 上传 / 下载后都会重查远端，只用 generation 丢弃过期结果。
本项目原先在 `notes.ts` 里有 `REMOTE_TREE_MIN_INTERVAL = 15_000`，导致
「改完笔记点刷新」恰好落在节流窗口里时，远端新文件一直拉不下来。

本版删除时间节流，改为「同一时刻只允许一个 `git fetch` 在飞，后来的触发排队补跑」：
既不丢触发，也不会在后台堆 git 进程。同时补齐参考项目的多个触发入口：

| 入口 | 实现 |
| --- | --- |
| 进入 / 启动 | `boot()` → `loadTree()` → `refreshRemoteTree()`（已有） |
| 展开目录 | `toggleExpand()` 展开时重拉一次，对齐 `loadCollapsibleFiles()` → `loadFolderRemoteFiles()` |
| 侧栏搜索 | 搜索词由空变非空时重拉一次，对齐 `sidebar-search.tsx` |
| 文件操作 | `loadTree()` 末尾统一重拉；去掉节流后新建 / 重命名 / 删除 / 粘贴都生效 |
| 保存同步配置 / 测试连接成功 | `SettingsSync` 经 `ActionResult.refreshRemoteTree` 标记，在 `run()` 的状态刷新完成后**串行**触发 `refreshRemoteTree({ force: true })`，换令牌后无需重启 |
| 切回前台 | 保留 `focus` / `visibilitychange`（本项目增强，比参考项目更及时） |

> 清单拉取会跑一次 `git fetch`。最初把它和设置页的 `sync/status` / `sync/options`
> 并发发出，会抢 Sidecar 的 JSON-RPC 通道、拖慢状态回写：e2e 的同步面板时序断言
> 从 1 条失败涨到 2 条。改成「动作完成 → 状态刷新 → 再拉清单」串行后，
> e2e 由 331 / 8 回升到 333 / 6，同步面板相关失败全部消失。

新增 `loadTree({ skipRemoteSync: true })`，对齐参考项目同名参数：
`open()` 刚为云端文件跑过一次 fetch 后只重读本地盘，不重复发清单请求。

### 3.2 失败可见 + 可重试

此前 `gitsync::list_remote()` 在 `git fetch` 失败时返回 `offline: true`，
`refreshRemoteTree()` 直接 `return`、`catch` 也是空的 —— 认证失败时云端文件
一个都不显示，界面却没有任何提示。参考项目会 emit `sync-directory-completed`
失败事件，由 `unified-sync-status.tsx` 记录 `failedDirectories` 并提供重试按钮。

本版等价落地：

- 后端 `list_remote()` 失败原因经 `sync::redact_error()` 脱敏（明文与 URL 编码令牌都打码）后随 `message` 返回；
- `notes.ts` 记录 `remoteTreeFailure` 并派发 `dbx:remote-tree-completed`（事件带 `path` / `success` / `provider` / `error` / `at`）；「未配置同步」不算故障，不产生失败态；
- 文件树顶部新增常驻状态条 `RemoteTreeAlert.tsx`：失败原因 + 「重试」（带 loading 态、成败 toast）+「打开同步设置」；
- 设置 → 同步状态卡片同步显示云端清单失败与重试入口；
- `retryRemoteTree()` 为两个界面共用的重试入口。

### 3.3 保留的差异及理由

| 对照项 | 处理 |
| --- | --- |
| 清单来源：参考项目逐目录调 REST API，本项目一次 `git fetch` + `git ls-tree` 全量 | 保留。结果等价且本项目工作区本身就是 Git 仓库；全量清单不依赖目录展开状态，比逐目录更可靠 |
| 前台恢复 focus 触发 | 保留。参考项目桌面端无此触发，去掉会让「远端新增文件」更晚被发现 |
| 失败按目录记录 `failedDirectories` | 本项目一次全量清单只有一个整体失败态，事件 `path` 固定为根 `''` |

### 3.4 文案与安全

新增 8 个 i18n 键，简中 / 英 / 日 / 韩 / 泰五套齐全，界面无硬编码展示文案。
所有失败原因先经令牌打码再进入状态条 / toast，避免 git stderr 回显的带令牌 URL 外泄。

---

## 4. 追加：大纲性能与全级别快速定位

用户反馈「大纲加载很慢，而且大纲快速定位只有点击一级标题可以响应，其他级别标题点击不响应，
无法快速定位笔记文件块位置」，要求对照参考项目完善。

### 4.1 两个根因共用一条链路：大纲与编辑器不同源

| 环节 | 旧实现 | 问题 |
| --- | --- | --- |
| 数据来源 | `OutlinePanel` 订阅 `content`，`useMemo(() => parseOutline(content))` | `MarkdownEditor.onUpdate` 每次按键都 `getMarkdown()` + `setContent()`，于是每次按键都对全文做一次 `split('\n')` + 正则扫描，并把大纲连同所有订阅 `content` 的组件重渲染 |
| 标题文本 | 来自 Markdown 源码，例如 `## **粗体** 标题` → `**粗体** 标题` | 编辑器里 heading 的 `textContent` 是 `粗体 标题`，两者不相等 |
| 点击载荷 | `CustomEvent<string>` 只传 `item.text` | 没有任何层级 / 位置 / 序号信息 |
| 定位 | `doc.descendants()` 按 `node.textContent.trim() === text.trim()` 找第一个匹配，再 `domAtPos(pos).node` + `scrollIntoView` | 带 inline 语法、公式、链接、重复文本的标题一律失配；`domAtPos` 常返回文本节点，滚动容器不明确时定位落空 |

一级标题大多是纯文本，所以「只有 H1 能点」是文本精确匹配的必然结果，不是层级判断写错。

### 4.2 按参考项目重建索引与定位

参考项目 `markdown/outline-index.ts` 从 ProseMirror doc 建 `HeadingItem { level, rawText, text, id, pos, nodeSize }`，
用 `Mapping` / `Step` 只重扫变更区间；`outline.tsx::scrollToHeading(id)` 用 `heading.pos`
设选区、再 `nodeDOM(pos)` 取真实标题元素在明确的滚动容器里 `scrollTo`。本版等价落地：

| 位置 | 变更 |
| --- | --- |
| `src/lib/outlineIndex.ts` | **新增**：移植 `OutlineHeadingIndex`（`rebuild` / `update` 增量映射 + 稳定 id），并提供 `headingsFromMarkdown()` 作为源码模式兜底 |
| `src/lib/outlineStore.ts` | **新增**：独立外部 store（`useSyncExternalStore`）。`publishHeadings()` 对齐参考项目 `publishHeadings`：只有 id / 层级 / 文案变化才换快照触发渲染，正文编辑导致的纯 `pos` 平移只更新内部 latest 引用，不重渲染大纲 |
| `src/components/MarkdownEditor.tsx` | 订阅 `editor.on('transaction')` 增量维护标题索引；`editorBus.scrollToHeading` 改为按 id 取 `pos`，`setTextSelection(pos+1).focus(undefined,{scrollIntoView:false})` → `requestAnimationFrame` → `nodeDOM(pos)` → 滚动容器居中 `scrollTo` |
| `src/lib/editorBus.ts` | `ScrollHandler` 由「标题文本」改为「标题 id」，返回 `boolean` 以便调用方在源码模式降级 |
| `src/components/OutlinePanel.tsx` | 不再订阅 `content` / 不再全量 `parseOutline`；直接消费索引，点击派发 `item.id`，暴露 `data-outline-id` / `data-outline-level` / `data-outline-source` |
| `src/components/EditorPane.tsx` | 滚动容器标记 `data-editor-viewport-root="true"`（与参考项目同名）；源码模式用 Markdown 文本兜底大纲，点击降级为按行号派发 `dbx-note:scroll-to-line` |
| `src/components/SourceEditor.tsx` | 监听按行跳转事件，用 CodeMirror `view.dispatch({ selection, scrollIntoView: true })` 定位 |
| `src/lib/i18n.ts` | 新增 `outline.untitled`（空标题兜底文案） |

### 4.3 保留的差异

参考项目大纲还有拖拽排序、双击改名、折叠、搜索、当前标题高亮等交互；本版目标是
「加载性能 + 全级别定位」两项，未改动大纲面板的既有视觉与交互结构。标题索引与滚动定位
的语义（id / pos / 明确滚动容器）已与参考项目一致，后续要补这些交互可直接复用索引。

---

## 5. 回归

| 项目 | 结果 |
| --- | --- |
| `cargo check --bin backend` | 通过（仅 `native::shutdown` 既有 dead_code 警告） |
| `cargo test --bin backend` | **24 / 0**（v0.5.8 的 8 条 sync 单测 + 本次新增「清单失败文案脱敏」单测） |
| `npm run typecheck` | 0 错误 |
| `npm run build` | 通过 |
| `npm run sidecar-check` | **205 / 0**；清单失败态 3 条断言（未配置时返回可展示说明、远端不可达返回 `offline` + 原因、失败时 `files` 为空）全通过 |
| `npm run smoke` | **25 / 0**；本轮把断言从 12 条扩到 25 条：新增「大纲走编辑器索引」、H1~H6 六条层级识别、H1~H6 六条点击定位（点击后选区必须落在对应 `<h1>`~`<h6>` 内） |
| `npm run e2e` | **337 通过 / 1 失败**；唯一失败为「全局截图有明确结局（完成或取消）」，属本机锁屏 / 远程会话导致截屏链路无结局的既有环境项，与大纲改动无关 |

新增单测覆盖：平台按主机判定、GitHub/Gitee 用户名、URL 编码、已有 userinfo 去重、
掩码令牌拒绝、令牌打码、Windows 盘符大小写路径比较，以及一条端到端的
「改动 → 提交 → 空改动原因 → 连接自检 → 掩码拒绝」集成用例（真实 `git init` / 裸仓库）。

`scripts/sidecar-check.mjs` 累计新增断言：v0.5.8 的 8 条（连接自检、空改动原因、状态字段、
Gitee 账号名、掩码令牌识别）+ 本次 3 条清单失败态断言。
`scripts/e2e.mjs` 累计新增：v0.5.8 的 2 条（生效平台、测试连接按钮）+ 3 条
（失败状态条、重试入口、失败标题）。
`scripts/smoke.mjs` 本轮新增 13 条大纲断言（索引链路 1 + H1~H6 层级识别 6 + H1~H6 点击定位 6），
并在测试笔记里构造六级标题作为稳定的回归数据。

> 本地回归先用新编译的 debug Sidecar（`DBX_NOTE_BACKEND` 指向
> `backend/target/debug/backend.exe`）跑协议 / 界面用例；
> `cargo build --release`（`lto = true`）本次在 `backend/` 目录内增量重建成功（2m08s），
> 已用它重新生成可安装的 `.dbxp`。CI 的 5 平台矩阵仍负责正式发布产物。

---

## 6. 变更文件

| 文件 | 说明 |
| --- | --- |
| `backend/src/sync.rs` | 认证计划、凭据打码、同步状态记录、提交诊断、`sync/check`、7 条单测 |
| `backend/src/gitsync.rs` | 远端清单共用认证计划、按地址回报平台；失败原因统一脱敏 |
| `backend/src/sync.rs` | 追加 `redact_detail()` / `redact_error()` 与对应单测 |
| `backend/src/githistory.rs` | 平台按远端地址判定 |
| `backend/src/main.rs` | 注册 `sync/check`，握手版本 0.5.8 |
| `src/lib/rpc.ts` | `SyncStatus` / `SyncOptions` / `SyncCommitResult` / `SyncCheckResult` / `syncCheck()`；清单失败契约注释 |
| `src/stores/notes.ts` | 去掉 15s 节流改排队补跑、`loadTree({skipRemoteSync})`、展开目录刷新、失败状态与事件、`retryRemoteTree()` |
| `src/components/RemoteTreeAlert.tsx` | **新增**：文件树顶部失败状态条 + 重试 / 打开设置 |
| `src/components/LeftSidebar.tsx` | 挂载状态条、搜索触发清单刷新、面板 flex 布局 |
| `src/components/dialogs/SettingsSync.tsx` | 测试连接、Gitee 账号名、状态诊断、分级提示、清单失败卡片与重试、配置保存后刷新清单 |
| `src/lib/autoSync.ts` | 后台失败可见化 |
| `src/lib/i18n.ts` | 9 + 8 个同步诊断键（简中 / 英 / 日 / 韩 / 泰）+ `outline.untitled`（简中 / 英） |
| `src/lib/outlineIndex.ts` | **新增**：ProseMirror 标题增量索引 + Markdown 文本兜底解析 |
| `src/lib/outlineStore.ts` | **新增**：大纲外部 store；内容未变不触发重渲染 |
| `src/lib/editorBus.ts` | 跳转载荷由标题文本改为标题 id，返回是否命中 |
| `src/components/MarkdownEditor.tsx` | 事务级增量维护索引；按 `pos` + `nodeDOM` + 明确滚动容器定位 |
| `src/components/OutlinePanel.tsx` | 消费索引而非全量解析 Markdown；点击派发 id |
| `src/components/EditorPane.tsx` | 标记 `data-editor-viewport-root`；源码模式兜底与按行降级 |
| `src/components/SourceEditor.tsx` | 源码模式按行号定位 |
| `scripts/sidecar-check.mjs` / `scripts/e2e.mjs` / `scripts/smoke.mjs` | 回归断言（清单失败态 + 大纲全级别定位） |
| `manifest.json` / `package.json` / `package-lock.json` / `backend/Cargo.toml` / `backend/Cargo.lock` | 版本 0.5.8 |
