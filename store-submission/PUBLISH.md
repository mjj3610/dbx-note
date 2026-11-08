# 发布到 DBX 商店

## 当前状态

| 项 | 值 |
| --- | --- |
| 插件 | `com.mjj3610.note` v0.5.0（`publisher: mjj3610`） |
| 候选 PR | https://github.com/t8y2/dbx-store/pull/469 （1 文件，+59 行，分支 `add-com.mjj3610.note-0.5.0`） |
| 候选包 | 5 个平台，见下表 |
| 源码 | https://github.com/mjj3610/dbx-note/tree/v0.5.0 |
| Release | https://github.com/mjj3610/dbx-note/releases/tag/v0.5.0 （CI run 42033509334，一次通过） |
| CI 状态 | `Validate catalog` 失败，**但这是预期的**：唯一错误是 `open candidate(s) awaiting DBX Store signing` |
| 待办 | 等维护者审核并评论 `/sign` 完成签名，CI 转绿后由维护者合并 |

候选包指纹（全部来自 CI 产物，未签名）：

| target | sha256 | size |
| --- | --- | --- |
| `windows-x64` | `acafb488fdfc2526df9c369286a7f4b48d485551baa655f2e642c37708742b8a` | 3,732,593 |
| `darwin-arm64` | `1f51f6c98eda9b5e73d2cf6373b7b7e9a0353ed656a4a65ad547bb659049cb8a` | 3,541,320 |
| `darwin-x64` | `599d3c2347daebf372d3584707a47bc6be879c17dc6221147b8614de3c014496` | 3,676,895 |
| `linux-arm64` | `cbf2e55f1c6d5375912b70ea9fed47c74d2763e569ad0939df2329e243f44335` | 3,612,345 |
| `linux-x64` | `adc194a40a5e93988a20df40982b9eea9ad3910286e2a784e48cacc3bf6f20f2` | 3,677,408 |

签名后维护者会把 `plugins/com.mjj3610.note.json`、`catalog/index.json` 写回 PR 并删掉
`candidates/*.json`。作者侧不需要、也不应该自己填 `signingKeyId` 或改 `verified`。

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

### 0.5.2 待办：同步与截图修复后需要重新出包

0.5.1 修了 Git 通道「打开笔记不拉取」，0.5.2 又补上了「进入文件树时拉远端目录清单 /
合并仅云端节点」（`docs/版本部署变更说明-v0.5.2.md`）以及全局截图选区 8 向缩放。
这两批改动 **都不在** #469 的候选包内 —— #469 的 5 个包是用 v0.5.0 的 tag 构建的。

所以上架前需要二选一：

1. 打 `v0.5.2` tag 让 CI 出 5 平台包 → 用新的 `release-candidates.json` 生成候选 →
   替换 #469（关掉重开，或直接更新 fork 分支）；
2. 先让维护者签 0.5.0（旧同步逻辑）上架，再按普通版本更新提 0.5.2。

按功能完整度，建议走第 1 条。注意候选 JSON 的 `sha256` / `size` 必须取 CI 产物，
不能用本机 mingw 包重新计算。

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
- 取仓库内容做本地校验：`GET /repos/t8y2/dbx-store/tarball/main`。

签名命令 `/sign` 只有维护者 `t8y2` 本人评论才生效（`sign-command.yml` 里写死了
`github.actor == 't8y2'`），作者侧无法触发，只能等。
