## 插件信息

- 插件 ID：`com.mjj3610.note`
- 版本：`0.4.0`
- 发布者：`mjj3610`（已有发布者，已上架 `com.mjj3610.mail`、`com.mjj3610.ebook`）
- 源码：https://github.com/mjj3610/dbx-note/tree/v0.4.0
- 许可证：GPL-3.0-or-later（依赖许可见 `THIRD-PARTY-NOTICES.md` 与 `licenses/`）
- 候选包：**1 个平台（`windows-x64`）**，来自本仓库 `v0.4.0` Release，**未签名**

本 PR 只新增 `candidates/com.mjj3610.note.json` 一个文件；
`publishers/mjj3610.json` 已存在，无需改动。`plugins/` 与 `catalog/` 未手动修改。

### 候选包指纹

| target | 文件 | sha256 | size |
| --- | --- | --- | --- |
| `windows-x64` | `com.mjj3610.note-0.4.0-windows-x64.dbxp` | `7b78db04c58266b5b68ed58625cc6c854a8d2dedd6dc8eedca90f96d3bf8a637` | 3727076 |

该包由本仓库 `.github/workflows/plugin-release.yml` 调用官方
`t8y2/dbx/.github/workflows/plugin-release-reusable.yml@main`，在 `windows-2022` runner 上构建；
`release-candidates.json` 由该工作流生成，其中 sha256 / size 与包字节逐字节一致。

## 能力（Capabilities）

- 1 个贡献点：`com.mjj3610.note.workbench`（笔记工作台）
- 前端 UI 运行在宿主沙箱 iframe 内，通过 Host API 与宿主交互；页面本身不做文件与网络访问
- 附带原生 Sidecar（Rust）：承担工作区文件读写、SQLite 存储、AI 请求代理、
  屏幕捕获与标注、剪贴板位图、麦克风录音、系统 OCR

工作台能力：

- **工作区就是一个普通文件夹**：用户任选目录，目录树、多标签、重命名/删除、外部变更检测、
  全文搜索都直接作用于 `.md` 文件，离开 DBX 依然可用
- **编辑器**：WYSIWYG（Tiptap）+ 源码模式（CodeMirror）。标题 1–6、列表、任务列表、引用、
  链接、下划线、表格逐单元格对齐、KaTeX 行内与块级公式、Mermaid 图表、代码块、
  标题折叠、GitHub 提示块、笔记内搜索替换
- **记录**：文字/链接/待办碎片，带标签、筛选、回收站，以及通过所配置模型「整理成笔记」
- **画布**：图形、图表、图片与手绘墨迹，存为工作区内的 `canvases/*.canvas.json`
- **AI 助手**：用户自行配置 OpenAI 兼容端点，流式对话、知识库检索、长期记忆、
  可选 MCP 工具调用；选中文本 AI（润色/缩写/扩写/翻译）仅确认后回写
- **截图**：全局热键或工具栏按钮 → 原生 1:1 桌面选区 → 就地标注 → 剪贴板/置顶/下载/
  插入笔记/存入记录
- **同步与备份**：Git（提交/拉取/推送）、对象存储/WebDAV/自建镜像，以及整库 zip 备份

## 权限（Permissions）

Manifest 声明 **`"permissions": []`** —— 无 `host.network` / `host.storage` / `host.events`
等任何权限。

原因：所有特权操作都由随包分发的 Sidecar 承担，Sidecar 以当前用户身份运行，
通过 stdin/stdout JSONL 与宿主通信；插件页面自身不需要任何宿主能力。

## 数据访问（Data access）

| 数据 | 位置 | 谁能读 |
| --- | --- | --- |
| 笔记、画布、附件 | 用户选定的工作区目录；未选时默认 `<plugin data dir>/workspace/` | 以当前用户运行的 Sidecar |
| 记录、标签、对话、消息、设置、文件历史 | `<plugin data dir>/dbx-note.db`（SQLite） | 同上 |
| 备份 | `<plugin data dir>/backups/*.zip` | 同上 |
| 屏幕截图 | 仅在内存中；只有用户显式导出时才写入工作区 `assets/` 或剪贴板 | 同上 |

无遥测、无统计、不内置第三方 SDK。除用户配置的目标（AI 端点、Git 远端、对象存储）外，
不上传任何内容。

## 网络访问（Network access）

所有 HTTP 都由 Sidecar 发出，插件页面不发起任何请求（宿主沙箱本身禁止）：

1. **AI 端点** — 用户在设置里填写的 OpenAI 兼容 base URL 与 Key（对话、视觉、语音转写）
2. **Git 远端** — 仅在用户执行同步并提供令牌时
3. **对象存储 / WebDAV / 自建镜像** — 仅在用户配置后
4. **远程图片抓取** — 笔记引用 https 图片时由 Sidecar 取回并内联为 data URL
   （宿主 CSP 禁止外链图片）

代码中不存在硬编码的上报地址，无自动更新，无后台轮询（除用户配置的同步间隔）。

## 原生行为（Native sidecar）

- 语言与实现：Rust（`backend/`，`rusqlite` 内置 SQLite、`reqwest` + rustls、`cpal`），
  随平台编译为 `bin/<target>/backend.exe`
- 协议：stdin/stdout JSONL，宿主 API 1（`plugin/initialize` 握手校验 id/version）
- 能力范围：
  - `files.*` — 工作区内文件读写、目录遍历、外部变更检测
  - `db.*` — 记录/标签/对话/设置/文件历史的 SQLite 存取
  - `ai.*` — 向用户配置的端点发起请求并流式回传
  - `screenshot.*` — GDI `BitBlt` 抓取虚拟桌面到置顶分层窗口，作为 1:1 选区；
    标注在同一窗口内以脏矩形重绘
  - `pin.*` — `SetWindowPos(HWND_TOPMOST)` 置顶，另有 1.5 s 复查定时器
  - `clipboard.*` — CF_DIB 写读，因其它程序可能占用剪贴板而带重试
  - `record.*` — `cpal` 采集 → WAV，再交给所配置的转写模型
  - `ocr.*` — `Windows.Media.Ocr` 跑在短命子进程（`backend.exe --ocr-once`）中，
    畸形图片不会拖垮主进程；子进程异常退出被转成普通错误返回
- 安全约束：
  - 不监听任何端口，仅通过 stdio 与宿主通信
  - 不加载动态库、不执行工作区中的任何内容
  - 以当前用户权限运行，不请求提权
- **平台说明**：截图（GDI / 分层窗口）、置顶（`SetWindowPos`）、剪贴板（`CF_DIB`）、
  OCR（WinRT）与全局热键（`RegisterHotKey`）都是直接的 Win32 调用，当前 `Cargo.toml` 中
  `windows-sys` 为无条件依赖，因此在 linux/darwin 上无法编译，本次只提交 `windows-x64`。
  其余平台会在补齐原生实现后以版本更新方式追加，不影响本条目已上架的内容。

## 测试

- `tsc --noEmit` 类型检查干净
- Sidecar 协议断言 116 项
- UI 冒烟 11 项
- 端到端 238 项（工作区、编辑器、表格、图片、记录、画布、同步、截图流程）
- 编辑器专项 31 项（表格浮动栏十项操作、提示块、搜索替换、快捷键、标题折叠）
- 详见仓库 README 的「验证」一节

---

补充说明：打包使用仓库内 `scripts/package.mjs`，产物布局为 `manifest.json`、
`bin/windows-x64/backend.exe`、`ui/`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`licenses/`、
`checksums.json`，**未签名**且不含 `signature.json`。包内 `manifest.json` 的
`id` / `version` / `publisher`（`com.mjj3610.note` / `0.4.0` / `mjj3610`）与候选元数据一致。
