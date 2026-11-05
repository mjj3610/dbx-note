# DBX 笔记 / Note Studio v0.4.0

First public release of the DBX notes plugin.

## What it is

A local-first Markdown note workbench that runs inside DBX. The workspace is a real folder of
`.md` files, so notes stay readable and editable outside DBX. Records, tags, chats and settings
live in the plugin's own SQLite database. A bundled Rust sidecar owns every privileged operation,
which is why the plugin page itself needs no file or network access.

## Highlights

- **Editor** — WYSIWYG (Tiptap) plus a source-mode toggle (CodeMirror). Headings 1–6, lists, task
  lists, quotes, links, underline, per-cell table alignment, KaTeX inline and block math, Mermaid
  diagrams, code blocks, heading folding.
- **In-note search and replace** — `Ctrl/⌘+F`, match counter, replace-all, match case,
  highlighted hits that clear on `Esc`.
- **GitHub alert callouts** — `> [!NOTE]` / `TIP` / `IMPORTANT` / `WARNING` / `CAUTION` with a
  type switcher, round-tripping through Markdown.
- **Rebuilt table toolbar** — row / column / align / delete groups with correct disabled states,
  active-alignment highlight, and tooltips that no longer cover the header row.
- **Records** — text / link / todo quick notes with tags, filters, trash and "organize into a note"
  through the configured model.
- **Canvas** — free-form board with shapes, charts, images and freehand ink.
- **AI assistant** — streaming chat over any OpenAI-compatible endpoint, knowledge-base retrieval,
  long-term memory, optional MCP tools, and selection AI (polish / shorten / expand / translate)
  that writes back only on confirm.
- **Screenshot** — global hotkey → native 1:1 desktop region selector → annotation toolbar →
  clipboard / pin on top / download / insert into note / save to records.
- **Sync & backup** — Git (commit/pull/push), object storage / WebDAV / self-hosted mirroring,
  plus full-workspace zip backups.

## Platforms

`windows-x64` for now. The sidecar's screen capture, always-on-top pinning, clipboard bitmap
handling, OCR and global hotkeys are direct Win32 calls, so the crate does not compile on
linux/darwin yet. Other targets will be added as they are implemented.

## Install

Download the `.dbxp` below and open it with DBX (plugin centre → install from file). These release
assets are **unsigned** — the DBX Store re-signs reviewed candidates with the store key, so the
marketplace build has a different signature.

## Verification before release

`tsc --noEmit` clean, 116 sidecar protocol assertions, 11 UI smoke assertions, 238 end-to-end
assertions, 31 editor assertions.
