# 第三方许可与致谢

DBX 笔记插件（`com.mjj3610.note`）以 **GPL-3.0-or-later** 发布。以下第三方组件随插件分发，
其许可证副本位于 `licenses/` 目录。

## 运行时依赖（前端）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| React / React DOM | 界面框架 | MIT |
| Zustand | 状态管理 | MIT |
| Tiptap（core / starter-kit / 各扩展） | Markdown 可视化编辑器 | MIT |
| CodeMirror 6（@codemirror/*, @uiw/react-codemirror） | Markdown 源码模式 | MIT |
| lowlight / highlight.js | 代码块高亮 | MIT / BSD-3-Clause |
| Radix UI（@radix-ui/*） | 无样式可访问组件 | MIT |
| lucide-react | 图标 | ISC |
| Tailwind CSS | 样式工具链 | MIT |
| class-variance-authority / clsx / tailwind-merge | 类名组合 | Apache-2.0 / MIT / MIT |
| marked | Markdown 渲染（AI 消息） | MIT |
| DOMPurify | HTML 消毒 | Apache-2.0 或 MPL-2.0（本项目按 Apache-2.0 使用） |
| sonner | 轻提示 | MIT |
| react-resizable-panels | 三栏拖拽布局 | MIT |
| KaTeX | 数学公式渲染（MathML 输出） | MIT |
| Mermaid | 图表渲染（流程图 / 时序图 / 甘特图等 8 种） | MIT |

## 原生 Sidecar（Rust）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| serde / serde_json | JSON 序列化 | MIT 或 Apache-2.0 |
| rusqlite（bundled SQLite） | 本地数据库 | MIT；SQLite 为 Public Domain |
| reqwest（rustls-tls） | 模型接口请求 | MIT 或 Apache-2.0 |
| rustls / ring | TLS 实现 | Apache-2.0 / ISC |
| uuid / chrono / walkdir / base64 | 通用工具 | Apache-2.0 或 MIT / MIT 或 Apache-2.0 / Unlicense 或 MIT / MIT 或 Apache-2.0 |

## 设计与产品参考

界面与交互参考了开源项目 **NoteGen**（https://github.com/codexu/note-gen，GPL-3.0）的产品形态，
代码为按 DBX 插件体系重新实现，未直接复制其源码。

## DBX 插件 SDK

Sidecar 的 JSON-RPC 协议实现参考 DBX 官方插件 SDK（Apache-2.0，上游 https://github.com/t8y2/dbx）。
