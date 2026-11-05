## 插件信息

- 插件 ID：`com.mjj3610.note`
- 版本：`0.5.0`
- 发布者：`mjj3610`（已有发布者，已上架 `com.mjj3610.mail`、`com.mjj3610.ebook`）
- 源码：https://github.com/mjj3610/dbx-note/tree/v0.5.0
- 许可证：GPL-3.0-or-later（依赖许可见 `THIRD-PARTY-NOTICES.md` 与 `licenses/`）
- 候选包：**5 个平台**（`windows-x64` / `darwin-arm64` / `darwin-x64` / `linux-arm64` / `linux-x64`），
  均来自本仓库 `v0.5.0` Release，**未签名**

本 PR 只新增 `candidates/com.mjj3610.note.json` 一个文件；
`publishers/mjj3610.json` 已存在，无需改动。`plugins/` 与 `catalog/` 未手动修改。

> 说明：此前 #459 提交的是 0.4.0 的单平台候选。维护者已于 13:06 审核通过、签名工作流在 13:10
> 完成签名，但我在 13:20 关闭它时没有注意到这些回复，因此 #459 是「已签名但关闭未合并」，
> 0.4.0 并未上架（签名产物仍在 fork `mjj3610/dbx-store` 的 `main`，提交 `b2936d9`）。
> 本次改为 0.5.0 且扩到 5 个平台，另开本 PR 便于按新版本重新审核；
> 若更希望先上 0.4.0，说一声我重开 #459，0.5.0 转后续更新 PR。

### 候选包指纹

| target | 文件 | sha256 | size |
| --- | --- | --- | --- |
| `windows-x64` | `com.mjj3610.note-0.5.0-windows-x64.dbxp` | `acafb488fdfc2526df9c369286a7f4b48d485551baa655f2e642c37708742b8a` | 3732593 |
| `darwin-arm64` | `com.mjj3610.note-0.5.0-darwin-arm64.dbxp` | `1f51f6c98eda9b5e73d2cf6373b7b7e9a0353ed656a4a65ad547bb659049cb8a` | 3541320 |
| `darwin-x64` | `com.mjj3610.note-0.5.0-darwin-x64.dbxp` | `599d3c2347daebf372d3584707a47bc6be879c17dc6221147b8614de3c014496` | 3676895 |
| `linux-arm64` | `com.mjj3610.note-0.5.0-linux-arm64.dbxp` | `cbf2e55f1c6d5375912b70ea9fed47c74d2763e569ad0939df2329e243f44335` | 3612345 |
| `linux-x64` | `com.mjj3610.note-0.5.0-linux-x64.dbxp` | `adc194a40a5e93988a20df40982b9eea9ad3910286e2a784e48cacc3bf6f20f2` | 3677408 |

这 5 个包由本仓库 `.github/workflows/plugin-release.yml` 调用官方
`t8y2/dbx/.github/workflows/plugin-release-reusable.yml@main`，在
`windows-2022` / `ubuntu-24.04` / `ubuntu-24.04-arm` / `macos-15-intel` / `macos-15`
五个 runner 上各自**原生编译**（不做交叉编译）后产出；`release-candidates.json` 由该工作流生成，
其中 sha256 / size 与包字节逐字节一致。

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
  可选 MCP 工具调用；选中文本 AI（润色/缩写/扩写/翻译）仅确认后回写。
  0.5.0 起支持**多厂商 + 多模型**：多家厂商可并存，模型从厂商接口拉取后点选加入，
  每个模型单独设用途/温度/top_p/max_tokens，对话、图片识别、语音转写可各用不同模型
- **截图**（Windows）：全局热键或工具栏按钮 → 原生 1:1 桌面选区 → 就地标注 → 剪贴板/置顶/
  下载/插入笔记/存入记录
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
  随平台编译为 `bin/<target>/backend[.exe]`
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
- **平台说明（0.5.0 变化）**：截图（GDI / 分层窗口）、置顶（`SetWindowPos`）、剪贴板（`CF_DIB`）、
  录音（`cpal`）与 OCR（WinRT）都是直接的 Win32 调用，0.5.0 已把它们收敛到
  `backend/src/{native,ocr,screenshot,pin,screenshot_ink}.rs` 并加 `#[cfg(windows)]`；
  macOS / Linux 编译同名同签名的 `backend/src/{native,ocr,screenshot}_stub.rs`，
  协议层照常分发，调用这些能力时返回「当前平台暂不支持该能力」。
  `windows-sys` / `png` / `cpal` 也改为仅 Windows 依赖（`[target.'cfg(target_os = "windows")']`）。
  **因此非 Windows 包不含任何 Win32 依赖，也不会加载 `windows-sys` 相关代码。**
  笔记、编辑器、AI、同步、画布等主流程在 5 个平台上完全一致。

| 平台 | 主流程 | 截图/贴图 | 剪贴板位图 | 麦克风录音 | 系统 OCR |
| --- | --- | --- | --- | --- | --- |
| Windows x64 | 完整 | 可用 | 可用 | 可用 | 可用（WinRT） |
| macOS arm64 / x64 | 完整 | 桩 | 桩 | 桩 | 桩 |
| Linux x64 / arm64 | 完整 | 桩 | 桩 | 桩 | 桩 |

## 测试

- `tsc --noEmit` 类型检查干净
- Sidecar 协议断言 **116 项**
- UI 冒烟 **11 项**
- 端到端 **241 项**（工作区、编辑器、表格、图片设置、记录、画布、同步、截图流程、
  AI 多厂商配置与流式对话）
- 5 个平台的编译与打包由本仓库 CI 矩阵实际验证（本次 Release 即产物）
- 详见仓库 README 的「验证」一节

---

补充说明：打包使用仓库内 `scripts/package.mjs`，产物布局为 `manifest.json`、
`bin/<target>/backend[.exe]`、`ui/`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`licenses/`、
`checksums.json`，**未签名**且不含 `signature.json`。包内 `manifest.json` 的
`id` / `version` / `publisher`（`com.mjj3610.note` / `0.5.0` / `mjj3610`）与候选元数据一致。
