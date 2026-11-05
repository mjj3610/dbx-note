# DBX 笔记 / Note Studio v0.5.0

本轮把 AI 配置从「只能配一个模型」改成**多厂商 + 多模型 + 按用途分配**，并修掉一处云同步的仓库判定问题。
升级无需手工迁移，旧配置在首次打开设置时自动转换。

## Highlights

### Multiple providers, multiple models

- 设置 →「AI 模型」现在是厂商卡片列表，可以同时放 OpenAI、Gemini、DeepSeek、通义千问、智谱、
  Moonshot、SiliconFlow、OpenRouter、Groq、Together、xAI、Ollama、LM Studio，也可以自定义任意兼容端点。
- 填好服务地址与密钥后点「测试连接」即可拉取该厂商的模型清单，点选模型名加入列表，不必手打模型名。
- 同一厂商共享一份地址与密钥，换 key 只改一处。

### One model per job

- 每个模型单独设置用途（对话 / 图片识别 / 语音转写 / 向量 / 语音合成）、温度、`top_p`、`max_tokens`、是否流式。
- 「对话与写作」「图片识别」「语音转写」三处各自指定模型——对话用便宜的、识图用多模态的、转写用专门的，
  同一插件里由不同模型分担不同任务。
- 没配 `vision` / `stt` 时自动回退到对话模型，只配过一个多模态模型的老用户不会突然失去识别与转写能力。
- AI 助手输入框上方的模型徽标可直接切换对话模型。

### Fixes

- 云同步不再把「位于某个仓库子目录里」的工作区误判成已初始化仓库。此前这种情况下「初始化仓库」按钮不出现，
  而「提交改动」会把笔记提交进**上层仓库**；现在只有工作区本身就是仓库根才算已初始化。
- `top_p` / `max_tokens` 按模型下发：`topP` 为 1、`maxTokens` 为 0 时完全不下发，避免被部分厂商拒绝。

## Platform support

This release ships one package per platform (native sidecars cannot be bundled into a single
universal package):

| Platform | Notes, editor, AI, sync, canvas | Screenshot / pin | Clipboard bitmap | Microphone | System OCR |
| --- | --- | --- | --- | --- | --- |
| Windows x64 | full | yes | yes | yes | yes (WinRT) |
| macOS arm64 / x64 | full | not yet | not yet | not yet | not yet |
| Linux x64 / arm64 | full | not yet | not yet | not yet | not yet |

On macOS and Linux the Win32-backed modules compile to stubs that return a readable
"not supported on this platform" error instead of failing to build. Image recognition still works
there through a configured vision model; only the free system-OCR path is Windows-only.

## Upgrade notes

- 旧版单模型配置（地址 / 密钥 / 模型名 / 温度）会自动迁移成「一家厂商 + 一个对话模型」并设为对话默认模型。
- 若此前在「图片与语音」页单独配过识别 / 转写模型，那套配置仍然优先，不受影响。
- 需要重启宿主或重载插件，页面才会用上新的前端产物。

## Verification

| 项目 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| `npm run build` | 通过（5758 modules） |
| `npm run backend` | 通过 |
| `npm run sidecar-check` | 116 / 0 |
| `npm run smoke` | 11 / 0 |
| `npm run e2e` | 241 / 0 |
