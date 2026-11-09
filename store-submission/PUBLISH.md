# 发布到 DBX 商店

## 当前状态

| 项 | 值 |
| --- | --- |
| 已上架版本 | `com.mjj3610.note` **v0.5.0**（#469 已于 2026-11-05 签名并合并） |
| 版本更新 PR | https://github.com/t8y2/dbx-store/pull/484 （0.5.0 → **0.5.2**，1 文件 +59 行，分支 `add-com.mjj3610.note-0.5.2`，open） |
| 候选包 | 5 个平台，见下表 |
| 源码 | https://github.com/mjj3610/dbx-note/tree/v0.5.2 |
| Release | https://github.com/mjj3610/dbx-note/releases/tag/v0.5.2 （CI run 42553966663，一次通过） |
| PR 校验 | `validate` 失败，**但这是预期的**：日志里唯一错误是 `Catalog contains 1 open candidate(s) awaiting DBX Store signing: com.mjj3610.note@0.5.2` |
| 待办 | 等维护者审核并评论 `/sign`；签名后 `validate` 转绿，由维护者合并 |

候选包指纹（全部来自 CI 的 `release-candidates.json`，未签名）：

| target | sha256 | size |
| --- | --- | --- |
| `windows-x64` | `0e6311e96907c4f4209e0167b16082da98c5f140136dbc1f4c6030778cf3d759` | 3,765,956 |
| `darwin-arm64` | `37b892ed43e8dcefaca4a1e698102879594cce9cc4ac5d32546820f2ce7629cc` | 3,567,991 |
| `darwin-x64` | `6aa1837c24438b37db895c6cd8e93a58c0bc54adfc475895b09518e9a77a5dc9` | 3,707,979 |
| `linux-arm64` | `4c525e9aad444a60b761ed567e46a8ab6dbee60c1228feea08423079554190b8` | 3,642,258 |
| `linux-x64` | `4e9547acaea48bb880b4758ab74a369b17caefc78c4aea6cbb46bc2df9f7ad4d` | 3,707,948 |

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

### 0.5.2 版本更新：已提交，等待签名

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
| 商店 PR | https://github.com/t8y2/dbx-store/pull/484 — open，diff 只有 `candidates/com.mjj3610.note.json` |
| 下一步 | 等维护者 `/sign` |

注意候选 JSON 的 `sha256` / `size` 必须取 CI 产物，不能用本机 mingw 包重新计算；
本机 debug 二进制只用于功能回归。发布工作流只认 `release: published` 事件，
建 draft 或事后编辑 Release 描述都不会触发构建。

### 0.5.3：代码已就绪，发布待决策

0.5.3 复刻了参考项目编辑器底栏的**复制 / 导出 / 历史版本**（`docs/版本部署变更说明-v0.5.3.md`），
并不在 #484 的 0.5.2 包内。

| 项 | 状态 |
| --- | --- |
| 代码 | 已提交本地 `main`（后端历史版本快照与 RPC、前端底栏 / 导出工具层 / 历史面板、i18n、回归） |
| 版本号 | `manifest.json`、`package.json`、`backend/Cargo.toml`、`PLUGIN_VERSION` 均为 `0.5.3` |
| 商店元数据 | `.dbx-store.json` 的 `source` 已指向 `v0.5.3`，`releaseNotes` 补 0.5.3 段落 |
| 文档 | `docs/release-notes-v0.5.3.md`、`docs/版本部署变更说明-v0.5.3.md`、`README.md` 功能矩阵与测试数 |
| 回归 | `cargo check` / `cargo build --release`、`tsc`、`vite build`、Sidecar **145/0**、smoke **12/0**、e2e **253/0** 全绿 |
| Release / 候选 / PR | **未创建**，等待决定发布策略 |

发布前要先处理 #484：它仍是 0.5.2 的候选、open 且等签名。可选
（a）等 #484 签名合并后再补一个 0.5.3 版本更新 PR；
（b）关掉 #484，直接以 0.5.3 提交一个版本更新 PR（一次签名拿最新功能）；
（c）暂不发版，只把代码推到 `main`。
按「每次发布前重新查 PR 状态」的教训，动手前必须再查 #484 是否已被 `/sign`。

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
