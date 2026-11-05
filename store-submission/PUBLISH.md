# 发布到 DBX 商店

## 当前状态

| 项 | 值 |
| --- | --- |
| 插件 | `com.mjj3610.note` v0.4.0（`publisher: mjj3610`） |
| 候选 PR | https://github.com/t8y2/dbx-store/pull/459 （1 文件，+35 行） |
| 候选包 | `windows-x64`，sha256 `7b78db04c58266b5b68ed58625cc6c854a8d2dedd6dc8eedca90f96d3bf8a637`，3,727,076 B |
| 源码 | https://github.com/mjj3610/dbx-note/tree/v0.4.0 |
| CI 状态 | `Validate catalog` 失败，**但这是预期的**：唯一错误是 `open candidate(s) awaiting DBX Store signing` |
| 待办 | 等维护者审核并评论 `/sign` 完成签名，CI 转绿后由维护者合并 |

签名后维护者会把 `plugins/com.mjj3610.note.json`、`catalog/index.json` 写回 PR 并删掉
`candidates/*.json`。作者侧不需要、也不应该自己填 `signingKeyId` 或改 `verified`。

## 关键认知

- **提交的不是 `.dbxp`**，而是一个只含元数据的 JSON。包由商店审核后用仓库密钥签名。
- **候选的 sha256 / size 必须来自 CI 产物**。本机只能打当前平台，且工具链不同字节必然不同：
  本次本地 mingw 包是 `5bb315d1…` / 3,717,088 B，CI 的 MSVC 包是 `7b78db04…` / 3,727,076 B。
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

最后提 PR。注意：本机经代理 `git clone`/`fetch` 拉 `t8y2/dbx-store` 会稳定 502，
但 `git push` 到自己的仓库正常，所以本地拿不到商店仓库的历史分支。绕过办法是用
contents API 直接在 fork 的 `main` 上落一个提交（历史与上游同源，PR diff 只有一个文件），
再开 PR：

```bash
node store-submission/open-pr.mjs
```

取商店仓库内容用于本地校验时，同样别用 `git clone`，改用 tarball：

```bash
curl -sSL --noproxy '*' -o .tmp/store.tgz \
  https://api.github.com/repos/t8y2/dbx-store/tarball/main
mkdir -p .tmp/dbx-store && tar -xzf .tmp/store.tgz -C .tmp/dbx-store --strip-components=1
```

## 多平台

出包矩阵在 `.github/workflows/plugin-release.yml` 的 `build-matrix` 里，当前只有
`windows-x64`：

```yaml
build-matrix: >-
  {"include":[{"runner":"windows-2022","target":"windows-x64"}]}
```

想加平台，把条目补进 `include` 即可，其余配置不用动 —— 官方工作流会在各自 runner 出包，
并在 publish 阶段校验「包未签名 + 各平台包内 manifest 身份一致」，再合并
`release-candidates.json`。

**但当前后端在非 Windows 上编译不过**，直接加条目会导致 publish 失败（`fail-fast: false`
只保证单个平台构建失败不影响其它平台构建，但 publish 需要全部构建成功）。实测数据：

| 模块 | 行数 | 依赖的 Win32 API |
| --- | --- | --- |
| `screenshot.rs` | 2409 | GDI `BitBlt`、分层窗口、`GetDIBits` |
| `screenshot_ink.rs` | 2126 | 同上的标注重绘循环 |
| `native.rs` | 828 | `RegisterHotKey`、剪贴板 `CF_DIB`、文件对话框 |
| `pin.rs` | 509 | `SetWindowPos(HWND_TOPMOST)` |
| `ocr.rs` | 345 | WinRT `Windows.Media.Ocr` |
| 合计 | 6217 / 12274 | 约占后端 51% |

且 `Cargo.toml` 里 `windows-sys` 是**无条件依赖**，所以 darwin/linux 上是编译失败而非运行期降级。
需要打桩的函数面只有 `native`(11) / `ocr`(3) / `screenshot`(11) 三组共约 25 个
（`ensure_dpi_awareness`、`focus_host_window` 已经是双分支实现）；`pin` 与 `screenshot_ink`
只被 `screenshot.rs` 内部使用，可以整体 `#[cfg(windows)]`。

补齐顺序建议：

1. **条件编译 + 桩实现**：`windows-sys` 移入 `[target.'cfg(windows)'.dependencies]`，
   三组模块按平台分文件，非 Windows 返回「当前平台不支持」，编辑器其余功能全部可用
2. **macOS 原生**：ScreenCaptureKit（需屏幕录制 TCC 授权）、`NSPasteboard`、
   `CGEventTap`（需辅助功能授权）、`Vision` OCR
3. **Linux**：X11 `XGetImage` / Wayland portal、`_NET_WM_STATE_ABOVE`、`XGrabKey`、
   外部 `tesseract`

商店按 target 逐条收录，追加平台是普通版本更新，不影响已上架条目
（`com.mjj3610.mail` 现在就是 5 个平台，也是逐步加的）。
