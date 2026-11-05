## Plugin submission

- Plugin ID: `com.mjj3610.note`
- Version: `0.4.0`
- Publisher ID: `mjj3610` (existing publisher — already listed: `com.mjj3610.mail`, `com.mjj3610.ebook`)

First listing for a new plugin. Files in this PR:

- `candidates/com.mjj3610.note.json` (new)
- `publishers/mjj3610.json` — already present, unchanged

## Source repository and tag

https://github.com/mjj3610/dbx-note/tree/v0.4.0

Candidate: `com.mjj3610.note-0.4.0-windows-x64.dbxp`, published at
https://github.com/mjj3610/dbx-note/releases/download/v0.4.0/com.mjj3610.note-0.4.0-windows-x64.dbxp
— sha256 `5bb315d1fa0a11448fb9380f6fdf354be3f781f91ca2b6bbe8eb0e848d380d74`, 3,717,088 bytes.
`release-candidates.json` is attached to the same release.

## Capabilities and user workflow

One `workbench` contribution (`com.mjj3610.note.workbench`, label 笔记). A local-first
Markdown note workbench:

- **Workspace = a real folder of `.md` files.** The user picks any directory; the tree, tabs,
  rename/delete, external-change detection and full-text search all operate on plain files, so
  the notes stay usable outside DBX.
- **Editor**: WYSIWYG (Tiptap) with a source-mode toggle (CodeMirror). Headings 1–6, lists, task
  lists, quotes, links, underline, per-cell table alignment, KaTeX inline and block math, Mermaid
  diagrams, code blocks, heading folding, GitHub alert callouts, in-note search and replace.
- **Records**: text / link / todo quick notes with tags, filters, trash and "organize into a note"
  through the configured model.
- **Canvas**: free-form board with shapes, charts, images and freehand ink, stored as
  `canvases/*.canvas.json` in the workspace.
- **AI assistant**: streaming chat over an OpenAI-compatible endpoint the user configures, plus
  knowledge-base full-text retrieval, long-term memory and optional MCP tool calls. Selection AI
  (polish / shorten / expand / translate) writes back only on confirm.
- **Screenshot**: global hotkey or toolbar button → native 1:1 desktop region selector → in-place
  annotation toolbar → clipboard / pin on top / download / insert into note / save to records.
- **Sync & backup**: Git (commit/pull/push), object-storage / WebDAV / self-hosted file mirroring,
  plus full-workspace zip backups.

## Permissions, data access, and network access

**Manifest permissions: none** — `"permissions": []`. The plugin uses no Host API capability that
requires a permission. Everything privileged goes through the bundled sidecar, which runs as the
current OS user over stdin/stdout JSONL.

Files and data the plugin touches:

| Data | Where | Who can read it |
| --- | --- | --- |
| Notes, canvases, attachments | The folder the user selects as workspace, or `<plugin data dir>/workspace/` by default | The sidecar process, under the current user |
| Records, tags, chats, messages, settings, file history | `<plugin data dir>/dbx-note.db` (SQLite) | Same |
| Backups | `<plugin data dir>/backups/*.zip` | Same |
| Screen captures | In memory; written to the workspace `assets/` or the clipboard only on an explicit export action | Same |

All HTTP is issued by the sidecar, never by the plugin page (the host sandbox forbids it):

1. **AI endpoint** — the OpenAI-compatible base URL + key the user enters in Settings (chat, vision,
   transcription).
2. **Git remote** — only when the user runs sync and supplies a token.
3. **Object storage / WebDAV / self-hosted mirror** — only when the user configures it.
4. **Remote image fetch** — a note referencing an HTTPS image is resolved by the sidecar and inlined
   as a data URL, because the host CSP blocks external images.

No hard-coded hosts, no auto-update, no telemetry, no analytics, no bundled third-party SDK, and no
background polling beyond the user-configured sync interval.

## Native sidecar behavior

`backend/` is a Rust binary (host API 1, protocol v1) packaged per target. This candidate is
**windows-x64 only** because the sidecar uses Win32 APIs:

- **Files / SQLite**: std `fs` + `rusqlite`, confined to the workspace and the plugin data dir.
- **AI transport**: `reqwest` with SSE streaming; the sandbox never sees the key.
- **Screen capture**: GDI `BitBlt` over the virtual desktop into a topmost layered window that
  serves as the 1:1 region selector; annotation is drawn in that same window with a dirty-rect
  repaint loop.
- **Pin on top**: `SetWindowPos(HWND_TOPMOST)` plus a 1.5 s re-assert timer.
- **Clipboard**: CF_DIB write / read, with retry because other applications can hold the clipboard.
- **Microphone**: `cpal` capture → WAV, then the configured transcription model.
- **OCR**: `Windows.Media.Ocr` in a short-lived child process (`backend.exe --ocr-once`) so a
  malformed image cannot take down the main sidecar; an abnormal child exit is surfaced as a normal
  error.

No listening sockets, no dynamic plugin loading, no execution of anything found in the workspace.

## License

GPL-3.0-or-later. Full text in `LICENSE`; dependency licences in `THIRD-PARTY-NOTICES.md` and
`licenses/`.

## Homepage or support URL

https://github.com/mjj3610/dbx-note

## Confirmation

- [x] The candidate packages are unsigned and match the disclosed source tag.
- [x] I have not included private keys, tokens, credentials, or proprietary data.
- [x] The candidates are listed in `candidates/com.mjj3610.note.json`; `plugins/` and `catalog/` were
      not edited manually.

---

Reviewer notes:

- `dbx-plugin package` was not used for this candidate: the build machine has no MSVC toolchain, so
  the sidecar was built with the mingw toolchain and packaged with the repo's `scripts/package.mjs`,
  which produces the same layout (`manifest.json`, `bin/windows-x64/backend.exe`, `ui/`, licences,
  `checksums.json`). The package is unsigned and carries no `signature.json`.
- Verification before packaging: `tsc --noEmit` clean, 116 sidecar protocol assertions, 11 UI smoke
  assertions, 238 end-to-end assertions, 31 editor assertions.
- `manifest.json` `id` / `version` / `publisher` (`com.mjj3610.note` / `0.4.0` / `mjj3610`) match
  the candidate metadata and the packaged manifest.
