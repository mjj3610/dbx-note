# New plugin: DBX 笔记 / Note Studio (`com.mjj3610.note`) v0.4.0

First listing for a new plugin from an existing publisher (`mjj3610`, already listed:
`com.mjj3610.mail`, `com.mjj3610.ebook`).

- Candidate: `candidates/com.mjj3610.note.json`
- Publisher record: `publishers/mjj3610.json` (already present, no change)
- Source tag: https://github.com/mjj3610/dbx-note/tree/v0.4.0
- Unsigned candidate: `com.mjj3610.note-0.4.0-windows-x64.dbxp`
  — sha256 `5bb315d1fa0a11448fb9380f6fdf354be3f781f91ca2b6bbe8eb0e848d380d74`, 3,717,088 bytes
- License: GPL-3.0-or-later (full text in `LICENSE`, dependency licences in
  `THIRD-PARTY-NOTICES.md` + `licenses/`)

## What the plugin does

A local-first Markdown note workbench that runs as a DBX workbench contribution:

- **Workspace = a real folder of `.md` files.** The user picks any directory; the tree,
  tabs, rename/delete, external-change detection and a full-text search all operate on
  plain files, so the notes stay usable outside DBX.
- **Editor**: WYSIWYG (Tiptap) with a source-mode toggle (CodeMirror). Headings 1–6,
  lists, task lists, quotes, links, underline, per-cell table alignment, KaTeX inline and
  block math, Mermaid diagrams, code blocks with 34 languages, heading folding, GitHub
  alert callouts, in-note search and replace.
- **Records**: text / link / todo quick notes with tags, filters, trash and “organize into
  a note” through the configured model.
- **Canvas**: free-form board with shapes, charts, images and freehand ink, stored as
  `canvases/*.canvas.json` in the workspace.
- **AI assistant**: streaming chat over an OpenAI-compatible endpoint configured by the
  user, plus knowledge-base full-text retrieval, long-term memory and optional MCP tool
  calls. Selection AI (polish / shorten / expand / translate) writes back only on confirm.
- **Screenshot**: global hotkey or toolbar button → native 1:1 desktop region selector →
  in-place annotation toolbar → clipboard / pin on top / download / insert into note /
  save to records.
- **Sync & backup**: Git (commit/pull/push), or object-storage/WebDAV/self-hosted file
  mirroring, plus full-workspace zip backups.

## Permissions

`manifest.json` declares **no host permissions** (`"permissions": []`). The plugin does not
use Host API capabilities that would need them; everything privileged goes through the
bundled sidecar, which runs as the current OS user.

## Data access

| Data | Where | Who can read it |
| --- | --- | --- |
| Notes, canvases, attachments | The folder the user selects as workspace, plus `<plugin data dir>/workspace/` by default | The sidecar process, under the current user |
| Records, tags, chats, messages, settings, file history | `<plugin data dir>/dbx-note.db` (SQLite) | Same |
| Backups | `<plugin data dir>/backups/*.zip` | Same |
| Screen captures | In memory; written to the workspace `assets/` or the clipboard only on an explicit export action | Same |

Nothing is uploaded anywhere unless the user configures a remote destination (AI endpoint,
Git remote, or object storage). There is no telemetry, no analytics and no bundled
third-party SDK.

## Network access

All HTTP is issued by the sidecar, never by the plugin page (the host sandbox forbids it):

1. **AI endpoint** — the OpenAI-compatible base URL + key the user enters in Settings
   (chat, vision, transcription, embeddings-free retrieval). Failures degrade to local
   behaviour, they never block editing.
2. **Git remote** — only when the user runs sync and supplies a token.
3. **Object storage / WebDAV / self-hosted mirror** — only when the user configures it.
4. **Remote image fetch** — a note that references an HTTPS image is resolved by the
   sidecar and inlined as a data URL, because the host CSP blocks external images.

No hard-coded hosts, no auto-update, no background polling beyond the user-configured
sync interval.

## Native sidecar behaviour

`backend/` is a Rust binary (`dbx-plugin` host API 1, protocol v1) packaged per target.
This candidate is **windows-x64 only**, because the sidecar uses Win32 APIs:

- **Files / SQLite**: std `fs` + `rusqlite` inside the plugin data dir and the workspace.
- **AI transport**: `reqwest` with SSE streaming; the sandbox never sees the key.
- **Screen capture**: GDI `BitBlt` over the virtual desktop into a topmost layered window
  for the 1:1 region selector; annotation is drawn in that same window with a dirty-rect
  repaint loop.
- **Pin on top**: `SetWindowPos(HWND_TOPMOST)` plus a 1.5 s re-assert timer.
- **Clipboard**: CF_DIB write / read, with retry because other apps can hold the clipboard.
- **Microphone**: `cpal` capture → WAV, then the configured transcription model.
- **OCR**: `Windows.Media.Ocr` executed in a short-lived child process
  (`backend.exe --ocr-once`) so a malformed image cannot take down the main sidecar; the
  parent turns an abnormal child exit into a normal error.

The sidecar does not load plugins, does not execute anything from the workspace, and does
not open listening sockets. It talks to the host over stdin/stdout JSONL only.

## Review notes

- `dbx-plugin package` was not used for this candidate because the local machine has no
  MSVC toolchain; the sidecar was built with the mingw toolchain and packaged with the
  repo's `scripts/package.mjs`, which produces the same layout (`manifest.json`,
  `bin/windows-x64/backend.exe`, `ui/`, licences, `checksums.json`). The package is
  unsigned and has no `signature.json`.
- Verification performed before packaging: `tsc --noEmit` clean, 116 sidecar protocol
  assertions, 11 UI smoke assertions, 238 end-to-end assertions, 31 editor assertions.
- `manifest.json` id / version / publisher (`com.mjj3610.note` / `0.4.0` / `mjj3610`) match
  the candidate metadata and the packaged manifest.
