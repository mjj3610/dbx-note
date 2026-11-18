# v0.5.11 发布说明（原生文件选择 / 刷新可见反馈）

> **发布状态**：`dev` 分支实现，**未打 tag、未发 Release、未提商店候选 PR**。
> 本版只解决用户反馈的一个体感问题：0.5.10 安装后「导入和上传都没有响应结果，
> 刷新按钮点了也没有任何响应」。
> 版本号统一为 `0.5.11`；部署与回滚见 `docs/版本部署变更说明-v0.5.11.md`。

## 1. 需求与根因

用户安装 0.5.10 后反馈：

- 文件更多菜单里的「上传本地文件 / 导入笔记 / 导入为 Markdown / 导入 Notion」点了没反应；
- 文件右键菜单里的「上传文件」点了没反应；
- 文件树刷新按钮点了也看不到任何变化。

排查结论：

1. DBX 宿主把插件 UI 放在 `sandbox="allow-scripts"` 的 iframe 中。
   隐藏 `<input type="file">` 的系统对话框在这种环境里可能不弹、不派发 `change`，
   或被焦点事件误判为取消；这是 0.5.10「上传 / 导入无响应」的根因。
2. 0.5.10 的 `pickFiles()` 仍用 `window.focus` + 120ms 判定取消。
   对话框正在打开时会先收到焦点变化，于是 Promise 被提前结算为空，
   用户选完文件也被丢弃。
3. 刷新按钮虽然调用了 `loadTree()`，但没有 loading 状态、没有完成 / 失败提示；
   树内容没变化时用户完全看不到任何响应。

## 2. 上传 / 导入：改走 Sidecar 原生文件对话框

和「另存为」一样，把系统对话框能力交给 Sidecar：

- `backend/src/native.rs` 新增 `dialog/openFiles`：
  - Windows 使用 `GetOpenFileNameW`，支持多选、`OFN_FILEMUSTEXIST` /
    `OFN_PATHMUSTEXIST` / `OFN_NOCHANGEDIR`；
  - 复用 `save_dialog_hook` 的置顶逻辑（`SetWindowPos(HWND_TOPMOST)` +
    `BringWindowToTop` + `SetForegroundWindow`），避免窗口被宿主盖住；
  - 返回 `{ name, contentBase64, size }[]`；
  - 单文件上限 32 MiB，单次总量上限 64 MiB；
  - `DBX_NOTE_PICKER_AUTO=1` 或非 Windows 返回 `unsupported`，
    让自动化测试和旧环境回退 DOM input；
  - 文件夹选择暂时返回 `unsupported`，前端回退 `webkitdirectory`。
- `backend/src/native_stub.rs` 补非 Windows 桩，`backend/src/main.rs` 注册新 RPC，
  `PLUGIN_VERSION` 升到 `0.5.11`。
- `src/lib/rpc.ts` 新增 `NativePickedFile` / `OpenFilesResult` 与 `dialogOpenFiles()`，
  超时 300s，等待用户在系统对话框里操作。
- `src/lib/fileActions.ts` 的 `pickFiles()` 改为原生 RPC 优先：
  - `unsupported` 或 RPC 异常才回退 DOM input；
  - 删除 focus / visibility 取消判定，DOM 回退只认 `change` 和 `cancel`；
  - `activePickerCancel` 只用于处理重复点击导致的未结算选择框；
  - 原生结果用 `ArrayBuffer` 中转包成 `File[]`，规避 TS 5.9 的 `BlobPart` 类型限制。

原 0.5.10 已完成的即时进度、6 路并发读取、增量插树全部保留。

## 3. 刷新按钮：忙碌态 + 结果提示

`src/components/LeftSidebar.tsx`：

- 新增 `refreshing` state，点击后按钮 `disabled` + `aria-busy`；
- 图标加 `animate-spin`；
- `loadTree()` 完成后按 `useNotesStore.getState().error` 弹
  `files.refreshDone` / `files.refreshFailed` toast；
- 按钮带 `data-files-refresh`，便于 smoke / e2e 断言。

`src/lib/i18n.ts` 新增 `files.refreshDone` / `files.refreshFailed`。

## 4. 兼容性

- 新增 1 个 RPC：`dialog/openFiles`；`manifest.permissions` 仍为 `[]`；
- 无新增 npm 依赖、无表结构变更、无 SQL / 迁移脚本、无新增设置项；
- 原生对话框只在 Windows Sidecar 生效；macOS / Linux 回退 DOM input；
- 自动化环境通过 `DBX_NOTE_PICKER_AUTO=1` 回退 DOM input，Playwright `filechooser` 链路不变；
- 单文件 32 MiB / 总 64 MiB 是新增的安全上限，超过会返回可读错误而非静默失败。

## 5. 回归

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npm run build` | 通过 |
| `cargo test --bin backend` | **28 / 0** |
| `npm run sidecar-check` | **216 / 0** |
| `npm run smoke` | **38 / 0** |
| `npm run e2e` | **351 / 0** |

新增断言：

- sidecar-check：自动化环境下 `dialog/openFiles` 返回 `unsupported`，
  并且不谎报已选文件；
- smoke：刷新按钮出现完成 toast、结束忙碌态；
- native.rs 单测：`open_filter_turns_accept_into_win32_pattern`。

## 6. 发布

本版**暂不发布**。需要在用户确认后执行：打 tag / Release → 等 5 平台 CI →
生成候选 → 提 DBX Store PR。当前商店候选仍是 v0.5.9 的 PR #507（等待维护者 `/sign`）。

## 7. 本地安装包与安装验证

`backend/` 目录内 `cargo +stable-x86_64-pc-windows-gnu build --release`
（首次全量重建 24m59s；修掉新增的未用 import 后增量重建 2m09s，
只剩既存 `shutdown` dead_code 警告），配合已构建的 `ui/`（`index-BYTYJZcp.js`），
用 `node scripts/package.mjs` 生成：

| 项目 | 值 |
| --- | --- |
| 包 | `release/com.mjj3610.note-0.5.11-windows-x64.dbxp` |
| 大小 | **3,952,345 B** |
| sha256 | `70d3b4c7b39dad75ff9b18ba06c72eea881e952f88e45767c34e80ed48056322` |
| 包校验 | **19 / 0**：大小 / sha256 / checksums（12/12）/ manifest `0.5.11` / 后端入口 / 权限空 / 包内 Sidecar 与磁盘字节一致 / 前端含原生选择与刷新反馈标记 |
| 包内 Sidecar 协议自检 | **216 / 0** |
| 包内 Sidecar 握手 | `plugin/initialize` → `version=0.5.11`，`ping` → `{"ok":true,"version":"0.5.11"}`；自动化环境下 `dialog/openFiles` → `unsupported` |

宿主目录按既有格式**纯增量落盘**（不修改 / 不删除 0.5.9 / 0.5.10）：

- `versions/0.5.11/`（13 文件，checksums 12/12 复核通过）；
- `activations/00000000000000000040-23da7c5b-9adc-4663-9581-bb7cb01ee1a3.json`
  （sequence 40，previousVersion 0.5.10）。

从宿主目录 Sidecar 跑握手同样回报 `version=0.5.11`。
回退：删掉 `versions\0.5.11\` 与 `activations\00000000000000000040-*.json` 即回到 0.5.10。

注意：落盘不会自动切换当前运行的 Sidecar，需要在 DBX 里**重启插件**加载 0.5.11。
自动化回归只验证 `dialog/openFiles` 的降级契约；真实 Win32 原生文件对话框
需要用户在 DBX 中点击「上传文件 / 导入笔记」实测。
