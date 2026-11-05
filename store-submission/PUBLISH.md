# 发布到 DBX 商店：操作手册

本仓库已具备提交所需的全部材料，只差「推送源码」「建 Release」「提 PR」三步外向操作。
下面按顺序执行即可，每步都给出可复制的命令或原文。

本地状态（已就绪，无需再改）：

| 项 | 值 |
| --- | --- |
| 未签名候选包 | `release/com.mjj3610.note-0.4.0-windows-x64.dbxp` |
| sha256 | `5bb315d1fa0a11448fb9380f6fdf354be3f781f91ca2b6bbe8eb0e848d380d74` |
| size | `3717088` |
| 包内 manifest | `com.mjj3610.note` / `0.4.0` / `mjj3610` |
| 候选元数据 | `store-submission/candidates/com.mjj3610.note.json` |
| PR 正文 | `store-submission/PR_BODY.md` |
| 发布者记录 | `publishers/mjj3610.json` 已存在于商店仓库，无需新建 |

---

## 最快路径：一条命令（推荐）

整个过程已固化成 `store-submission/publish.mjs`，它会按顺序做完：建仓库 → 推源码与
`v0.4.0` tag → 建 Release 并上传 3 个文件 → fork `t8y2/dbx-store` → 写入候选元数据 → 提 PR。

先跑一次只读校验，确认本地材料和包字节都没问题（不需要 token）：

```bash
node store-submission/publish.mjs --dry-run
```

预期输出：

```
[1/6] 校验本地材料
  ✓ 身份一致：com.mjj3610.note 0.4.0 mjj3610
  ✓ windows-x64  com.mjj3610.note-0.4.0-windows-x64.dbxp  5bb315d1fa0a1144…  3717088 B
  ✓ release-candidates.json 已就绪
  ✓ 发布 tag：v0.4.0
--dry-run：本地材料校验通过，未发起任何网络写操作。
```

校验通过后带上 token 真正提交：

```bash
GITHUB_TOKEN=你的token node store-submission/publish.mjs
```

Token 建议用 **fine-grained**，权限只要：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Contents | Read and write | 推源码、建 Release、传产物、写 fork 的候选文件 |
| Workflows | Read and write | 仓库里有 `.github/workflows/plugin-release.yml`，缺这项推送会被拒 |
| Administration | Read and write | 仅首次允许脚本自动建仓库；你已在网页建好则可以不给 |

脚本的特性：

- token 只从环境变量读，**不写进 `.git/config`、不落盘**；推送用一次性 URL 参数
- 可重复执行：仓库已存在就跳过、Release 已存在就复用、资产同名就跳过、PR 已存在就打印地址
- 上传前先核对本地 `.dbxp` 的 sha256 与 size 是否与候选钉住的值**逐字节一致**，
  不一致直接中止，不会把错包传上去
- 传完会真的 `HEAD` 一次候选 URL，确认商店 CI 能下载到

只想做到「仓库 + Release」、PR 稍后自己提，加 `--skip-pr`。

> 若 token 没有 Administration 权限、建仓库被拒，先在
> https://github.com/new 建一个**空的** public 仓库 `dbx-note`（不要勾 README），
> 再重跑脚本即可 —— 其余步骤会自动接管。

下面是从零手工操作的完整版本，脚本跑不通时按它逐条排查。

---

## 第 1 步：把源码推到 GitHub

商店要求「源码必须公开可审查」，`candidates/*.json` 里的 `source` 字段也指向这个仓库。

在 https://github.com/new 新建 **public** 仓库，名字填 `dbx-note`，**不要**勾选
"Add a README"（保持空仓库），然后在本地执行：

```bash
cd G:/workspace/dbx-plugin/dbx-note
git remote add origin https://github.com/mjj3610/dbx-note.git
git push -u origin main
```

> 仓库里已排除 `node_modules/`、`ui/`、`release/`、`backend/target/`、`screenshots/`、
> `.workbuddy/`，共 147 个文件、约 1.4 MB，可以安全公开。

---

## 第 2 步：打 tag 并建 Release（关键：URL 必须与候选文件一致）

商店 CI 会**真的去下载**这个 URL 并按 sha256 校验字节，所以 URL 必须完全一致：

```
https://github.com/mjj3610/dbx-note/releases/download/v0.4.0/com.mjj3610.note-0.4.0-windows-x64.dbxp
```

打 tag：

```bash
git tag -a v0.4.0 -m "DBX 笔记 v0.4.0"
git push origin v0.4.0
```

建 Release：https://github.com/mjj3610/dbx-note/releases/new → tag 选 `v0.4.0`，
标题 `v0.4.0`，然后上传这 3 个文件（来自本地 `release/`）：

1. `com.mjj3610.note-0.4.0-windows-x64.dbxp`
2. `com.mjj3610.note-0.4.0-windows-x64.artifact.json`
3. `release-candidates.json`

> `release-candidates.json` 由 `node scripts/make-release-candidates.mjs` 生成，
> 是商店自动化同步新版本时读取的汇总清单。

也可以在网页上直接建 Release（tag 会自动创建），省掉上面两条 `git tag` 命令。
Release 建好后，确认这个链接能直接下载：
```bash
curl -sIL https://github.com/mjj3610/dbx-note/releases/download/v0.4.0/com.mjj3610.note-0.4.0-windows-x64.dbxp | head -1
```
应返回 `HTTP/2 200`。**这一步不通过，PR 的 CI 一定红。**

---

## 第 3 步：向商店提候选 PR

1. Fork https://github.com/t8y2/dbx-store （fork 到 `mjj3610/dbx-store`）
2. 在 fork 里新建文件 `candidates/com.mjj3610.note.json`，内容就是本仓库的
   `store-submission/candidates/com.mjj3610.note.json`
3. 向 `t8y2/dbx-store:main` 提 PR，标题：
   `Add com.mjj3610.note v0.4.0 (new plugin)`
4. PR 正文粘贴 `store-submission/PR_BODY.md` 的全文

**只加这一个文件。** 不要动 `plugins/*.json`、`catalog/index.json`，
签名工作流会自动生成它们。

提上去之后 CI 会是**红的**，提示 `open candidate(s) awaiting DBX Store signing` ——
这是设计如此，用来阻止未签名产物被合并。

---

## 第 4 步：等维护者签名

维护者在 PR 下评论 `/sign` 后，「Sign plugin PR candidates」工作流会：

1. 把 PR 分支与 base 同步
2. 下载候选包、校验 sha256/size、确认包未签名且 manifest 身份匹配
3. 用仓库私钥签名，把签名产物发到 `<plugin-id>-<version>` 的 Release
4. 把 `plugins/com.mjj3610.note.json`、重新生成的 `catalog/index.json` 提交回你的 PR，
   并删掉 `candidates/com.mjj3610.note.json`

CI 转绿后维护者合并，插件即上架。**作者始终拿不到商店私钥，这一步无法自己完成。**

---

## 多平台包：为什么这版只有 windows-x64

不是漏了，是当前代码**在非 Windows 上编译不过**。实测数据：

| 模块 | 行数 | 依赖的 API |
| --- | --- | --- |
| `screenshot.rs` | 2409 | GDI `BitBlt`、分层窗口、`GetDIBits` |
| `screenshot_ink.rs` | 2126 | 同上的标注重绘循环 |
| `pin.rs` | 509 | `SetWindowPos(HWND_TOPMOST)` |
| `native.rs` | 828 | `RegisterHotKey`、剪贴板 `CF_DIB`、文件对话框 |
| `ocr.rs` | 345 | WinRT `Windows.Media.Ocr` |
| **合计** | **6217** / 12274 | 约占后端 51% |

而且 `Cargo.toml` 里 `windows-sys` 是**无条件依赖**（不在 `[target.'cfg(...)']` 段下），
所以在 macOS / Linux 上 `cargo build` 直接失败，不是运行期降级。

其余约 6000 行（`files` 文件读写、`db` SQLite、`ai` 流式对话、`sync`/`storesync` Git 与对象存储、
`imagehost` 图床、`backup`、`canvas`、`mcp`）本身是跨平台的，这部分可以复用。

### 补齐多平台的三个阶段

**阶段一：先让它能在别的平台编译（约 1 天）**

- `windows-sys` 挪进 `[target.'cfg(target_os = "windows")'.dependencies]`
- 把 5 个平台模块改成 `#[cfg(windows)]` 的 `mod`，为 darwin/linux 提供同签名桩实现：
  截图/置顶/OCR/全局热键返回「当前平台不支持」，编辑器其余功能全部可用
- CI 矩阵加 `ubuntu-latest`、`macos-14`（arm64）

产出：`linux-x64`、`darwin-arm64`、`darwin-x64` 三个**功能降级但可用**的包。

**阶段二：补 macOS 原生能力（约 3–5 天，且必须有 Mac 实测）**

- 截图：`CGDisplayCreateImageForRect` 或 ScreenCaptureKit；需要「屏幕录制」TCC 授权，
  首次调用要引导用户去系统设置
- 置顶：`NSWindow.level = .floating`
- 剪贴板：`NSPasteboard`（PNG/TIFF）
- 全局热键：`CGEventTap`，需要「辅助功能」授权
- OCR：`Vision` 框架 `VNRecognizeTextRequest`（比 WinRT 更准，且支持中英混排）

**阶段三：补 Linux（约 2–4 天，环境碎片化，Wayland 最麻烦）**

- 截图：X11 走 `XGetImage`，Wayland 只能走 `org.freedesktop.portal.Screenshot`
  （会弹系统确认框，无法做 1:1 实时框选）
- 置顶：`_NET_WM_STATE_ABOVE`
- 全局热键：X11 `XGrabKey`；Wayland 无通用方案，只能让用户绑桌面快捷键
- OCR：依赖外部 `tesseract` 可执行文件

### 建议的节奏

**不要等。** 商店是按 target 逐条收录的，`windows-x64` 可以先上；
后续版本追加新平台就是一次普通的版本更新（提 `candidates/<id>.json` 带新 version 即可），
不影响已上架的条目。参考 `com.mjj3610.mail` 现在就是 5 个平台，也是逐步加的。

所以建议：**v0.4.0 先以 windows-x64 上架**，阶段一作为 v0.5.0 的内容。
