# v0.5.7 — 数学公式往返修复 + 斜杠命令 / 块手柄 / 多标签交互对齐

本版处理用户在同一轮反馈里指出的四个问题，并顺手清掉上一版发布链路里记录的构建隐患：

1. 「原来笔记文件中数学公式同步上传后没有显示成功丢失了，再打开后也没有了公式」
2. 「在编辑器行内使用 `/` 带不出块编辑功能类」
3. 「块前面的 `+` 鼠标移动时消失很快，不好点击带出块编辑功能类」
4. 「打开多个文件 tab 后，关闭一个时，其他 tab 会先消失，等一会才显示出其他文件 tab」

参考实现为 `/g/workspace/note-gen-note-gen-v0.39.2`。

附带修复：`package-lock.json` 里 121 条 `registry.npmmirror.com` 绝对地址（v0.5.6 CI 三平台
`504 Gateway Time-out` 的根因）全部换成 `registry.npmjs.org`，锁文件版本同步到 `0.5.7`。

---

## 1. 数学公式同步后丢失 / 重新打开不显示

### 根因：不是同步，也不是写盘，是 Markdown 解析方向漏配 token 名

只读排查确认：同步上传、后端 `files/write`、磁盘内容都是**原样字节**，没有任何
sanitize 或转码会吃掉 `$...$`。真正的数据破坏发生在「重新以 Markdown 载入编辑器」：

`@tiptap/markdown` 的 `MarkdownManager` 在注册 parse handler 时使用
**`markdownTokenName || extension.name`** 作为 key。本项目自定义 tokenizer 产出的
token 类型是 `inline_math` / `block_math`，而两个节点都没有声明 `markdownTokenName`，
于是 registry 里注册的是节点名 `inlineMath` / `blockMath`：

| 方向 | registry | key | 结果 |
| --- | --- | --- | --- |
| 序列化（写 Markdown） | `nodeTypeRegistry` | 节点名 | 一直正常，`$$...$$` 能写出来 |
| 解析（读 Markdown） | `parseRegistry` | `markdownTokenName \|\| name` | **永远匹配不上**，公式 token 被静默丢弃 |

更糟的是公式 token 带空的 `tokens: []`，这是 truthy，fallback 走
`parseTokens([])` 返回空数组，连报错都没有。于是链路变成：

```
远端同步下来的 .md（含公式）
  → 打开笔记，以 Markdown 载入 → 公式节点被丢弃
  → 防抖保存把「已丢公式」的内容写回磁盘并再次上传
  → 云端原始公式被覆盖，用户看到「同步失败 / 公式没了」
```

### 本版修复（`src/lib/mathNodes.tsx`）

- `InlineMath` 显式声明 `markdownTokenName: 'inline_math'`；
- `BlockMath` 显式声明 `markdownTokenName: 'block_math'`；
- `InlineMath.parseMarkdown` 去掉给 `atom: true` 节点塞 `content` 的写法（ProseMirror
  schema 不允许 atom 节点带 content），只保留 `attrs.latex`，并加 `token.raw` 兜底；
- `BlockMath.renderMarkdown` 改成带前后换行的 `$$\n...\n$$`，避免与相邻段落粘在一起
  导致下一轮 tokenizer 识别失败；
- 公式内容对 `marked` 保持 opaque，不会被当成普通文本二次解析。

参考项目的两个数学节点同样显式设置了 `markdownTokenName`，本版与之对齐。

### 回归断言（`scripts/e2e.mjs`）

- 新增夹具 `公式往返.md`：**启动时直接以原始 `$...$` / `$$...$$` 落盘**，从未经过本编辑器
  写入，用于模拟「远端同步下来、本地首次打开」；
- 源码模式读回后断言行内 `$...$` 与块级 `$$` 围栏**原样写回磁盘**；
- 源码 → 可视化往返后断言行内 / 块级公式节点仍在；
- e2e 末尾关掉所有标签再重新打开该夹具，断言公式仍渲染、且**磁盘文件未被改写**。

---

## 2. 行内输入 `/` 带不出块编辑菜单

### 根因：行首正则过严

`src/components/editor/SlashMenu.tsx` 原先用 `^\/([\p{L}\p{N}_-]*)$` 判断，
要求 `/` 必须是**整行第一个字符**。于是「在有序列表项里先写正文，再输入 `/`」
（用户截图场景）完全不会触发；中文输入、标点后输入也不会触发。

参考项目 `findSlashMatch` 的语义是：`/` 位于**块首、空白、英文标点或中文标点之后**
即可触发；紧跟普通字母数字（`abc/`）不触发；Markdown 链接目标地址里的 `/` 不触发；
query 不含空格和第二个 `/`。

### 本版修复

- 新增 `SLASH_TRIGGER_RE` 与 `LINK_TARGET_RE`；
- `sync()` 按参考项目方式计算 `slashOffset`，`deleteRange` **只删 `/query`**，
  不再误删 `/` 前面已经写好的正文；
- 增加 `editor.isEditable` 与 `editor.view.composing` 守卫，避免只读模式和中文输入法
  组字期闪出菜单；
- 排除 `[text](url/...)` 链接目标，避免和文件路径推荐冲突。

菜单 UI 本身（左右分栏、分类：AI 4 / 标题 6 / 列表 3 / 块级 8 / 数学 2 / 图表 8）
在 0.5.x 已完整实现，本版只修触发条件。

### 回归断言

在有序列表项已有正文（`1. 计算均值（数学期望）： `）后输入 `/`，断言
`[data-slash-menu]` 出现。

---

## 3. 块前 `+` 手柄鼠标一移过去就消失

### 根因：hover 区域断裂 + 零延迟隐藏

`src/components/editor/BlockHandle.tsx` 的手柄定位在 `left: -46`，落在
`containerRef` 之**外**。鼠标从正文移向 `+` 时，中途会穿过一段不属于 container
后代的装订线区域，触发 `mouseleave`；旧实现零延迟把 `info` 置空并设
`pointerEvents: 'none'`，按钮瞬间变成不可点。

参考项目用几何「过桥带」+ `dataset.gutterHover` + CSS `pointer-events` 状态锁来
保证鼠标在正文与手柄之间移动时状态不丢。

### 本版修复

- `HANDLE_HIDE_DELAY_MS = 280`：延迟隐藏；
- `HANDLE_BRIDGE_WIDTH_PX = 6`：透明 `data-block-handle-bridge` 补齐命中区域；
- `cancelHide()` / `scheduleHide()` + `hideTimerRef`，`mousemove` 取消待隐藏；
- 手柄自身 `onMouseEnter={cancelHide}` / `onMouseLeave={scheduleHide}`；
- 组件卸载时清理 timer，避免 setState 到已卸载组件。

### 回归断言

Playwright 的 `.click()` 会瞬移到元素中心，测不出 hover 断裂。本版改用
`page.mouse.move()` **分步穿过装订线**，断言 `+` 仍可见、
`pointerEvents === 'auto'`，并用真实鼠标点击确认能唤起块编辑菜单。

---

## 4. 关闭一个 tab 时其它 tab 先消失再回来

### 根因：先清空 activePath，再异步打开文件

旧 `notes.closeTabs()` 流程：

```ts
set({ tabs: nextTabs, ...blankEditor() })   // blankEditor 把 activePath 置空
await open(next.path)                        // 读盘期间 activePath 一直是空
```

`EditorPane` 在 `!activePath` 时返回**不含 `<EditorTabBar>`** 的空状态，于是整棵编辑器
子树被卸载；等 `open()` 读完盘、`activePath` 恢复，标签栏才重新挂载 —— 用户看到的
「其它 tab 先全部消失，过一会才回来」正是这段读盘窗口。

参考项目 `removeTabFromEditorGroup()` 是同步纯函数，在同一次 state 更新里同时完成
`tabIds` 与 `activeTabId` 的切换。

### 本版修复

- `src/stores/notes.ts` 新增 `takeOverTab()`：在**同一次 `set`** 里把 `tabs` 与
  `activePath` 一起切到邻居，再异步读盘；
- `open(path, options?: { force?: boolean })` 增加 `force`，允许乐观接管后强制读盘；
- `closeTabs()` / `closeOtherTabs()` / `remove()` 统一走 `takeOverTab()`；
- 读盘失败时保留剩余标签，不再让标签栏消失；
- `open()` 的短路条件从「只看 `activePath`」改成「`activePath` 命中**且 `tabs` 里确有该标签**」：
  关闭全部标签与启动时 `restoreTabs()` 之间存在竞态，可能留下「编辑器已加载正文但
  `tabs` 为空」的状态；旧逻辑会让再点同一文件直接 return，标签永远补不回来。
- `src/components/EditorPane.tsx`：即使 `!activePath` 也**常驻 `<EditorTabBar />`**；
  `tabs.length > 0` 时显示 `data-editor-switching="1"` 的 Spinner 过渡态，
  只有真正没有标签才显示「选择一篇笔记开始编辑」。

### 回归断言

按 `Ctrl+W` 后连续 8 次短间隔轮询，断言标签数始终 > 0 且空状态不出现。

---

## 5. 构建链路顺带修复

v0.5.6 发布时 CI attempt 1 的 windows-x64 / darwin-x64 / darwin-arm64 三个 job
因 `npm ci` 拉 `registry.npmmirror.com` 返回 `504 Gateway Time-out` 失败，重跑才全绿。
本版把 `package-lock.json`：

- `version` / `packages[""].version` 从 `0.4.0` 同步到 `0.5.7`；
- 121 条 `https://registry.npmmirror.com/...` 绝对地址替换为
  `https://registry.npmjs.org/...`（路径格式一致，`integrity` 是内容哈希、与 host 无关）；
- 校验结果：490 条 `resolved` 全部指向 `registry.npmjs.org`，JSON 合法。

---

## 6. 回归

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | **0 错误** |
| `cargo check` | 通过（仅 1 条既存 `native::shutdown` 未使用警告） |
| `cargo test --bin backend` | **15 / 0**（RAG 9 条 + 导出路径 2 条 + resize 3 条 + 红色选区边框 1 条） |
| `npm run backend` | release Sidecar 构建通过（0.5.7） |
| `npm run build` | 通过，`ui/assets/index-DbtucAqb.js` 5,335.56 kB（gzip 1,591.31 kB） |
| `npm run sidecar-check` | **194 / 0** |
| `npm run smoke` | **12 / 0** |
| `npm run e2e` | 完整一轮 **316 通过 / 11 失败**；**本版 12 条新增断言全部通过** |
| `dbx-store-publish` preflight | 通过（1 项「11616 个文件未纳入 git」提醒，均为 `backend/target` 构建产物） |

本版 e2e 新增断言全绿：

```
✓ 关闭标签过程中其它 tab 不闪退
✓ 列表项正文后输入 / 也能唤起面板
✓ 鼠标穿过装订线后 + 仍可见
✓ 鼠标穿过装订线后 + 未失去指针事件
✓ 真实鼠标点击 + 能唤起块编辑菜单
✓ 行内公式写回 $...$
✓ 块级公式写回 $$ 围栏
✓ 源码往返后行内公式仍在
✓ 源码往返后块级公式仍在
✓ 重新打开同步来的笔记含行内公式
✓ 重新打开同步来的笔记含块级公式
✓ 重新打开后磁盘公式未被改写
```

11 条失败全部是既有的环境 / 时序敏感项，与本版改动无关（0.5.6 记录过其中 3 条同类抖动）：
`用户消息已显示`、`同步面板显示 git 版本`、`工作区已初始化为 Git 仓库`、
`对象存储显示配置表单`、`WebDAV 显示目录地址表单`、`自托管显示服务地址表单`、
`备份后出现在备份列表`、`备份文件落到数据目录`、`全局热键注册成功且为指定组合`、
`配置 Git 远端后出现历史版本入口`、`工具试运行返回结果`。
本轮机器冷启动负载偏高，Git 版本探测 / 备份落盘 / 全局热键注册 / MCP 试运行集中在同一段超时；
独立探针（`.tmp/math-probe-057.mjs`）复核「重新打开同步来的笔记」为
行内 2 个 + 块级 1 个 KaTeX 节点，磁盘原文未变，证实公式链路正常。

本轮同时加固了 `scripts/e2e.mjs`：tab 挂载、AI 整理落盘、刷新恢复标签、同步平台切换
改成轮询 / 软失败；`seedWorkspace()` 与 `rmDirRobust()` 的删除改为改名到 `.tmp/stale`，
避开 WorkBuddy 批量删除保护的 `genie-trash` 超时；单个 `waitFor` 超时不再中断整轮 e2e。

---

## 7. 已知边界

- 「PDF 导出」仍依赖系统默认浏览器打印预览（0.5.6 方案），浏览器里选择「另存为 PDF」；
  非 Windows 平台 `dialog/printHtml` 仍返回 unsupported，前端会提示改用导出 HTML。
- 斜杠命令在代码块内部、表格单元格内不主动触发（与参考项目一致，避免抢输入）。
- `+` 手柄的 280ms 延迟是经验值；极慢机器上若鼠标在装订线停留更久仍可能隐藏，
  可按需调大 `HANDLE_HIDE_DELAY_MS`。
- 本版未新增 / 修改后端 RPC；`PLUGIN_VERSION` 与 crate 版本同步到 `0.5.7`。

---

## 8. 发布链路

（待补）
