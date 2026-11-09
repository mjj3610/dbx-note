/**
 * 笔记「复制 / 导出」工具层（对齐参考项目 footer-bar + markdown-export.ts）
 *
 * 关键语义：
 * - 桌面端导出走 **Sidecar 系统「另存为」对话框**，用户自己选路径，写盘后返回实际路径；
 *   取消不写盘也不报成功；当前平台没有原生对话框时才降级为浏览器 Blob 下载。
 *   宿主 iframe 里的 `<a download>` 可能被沙箱吞掉，不能作为默认落盘方式。
 * - JSON 导出的是 **Tiptap JSON 文档**（`MarkdownManager.parse`），不是 marked 的 token 树。
 * - HTML 导出会把工作区图片内联成 data URL，避免导出文件离开工作区后丢图。
 * - PDF 走系统打印窗口，打印不可用时降级导出 HTML。
 *
 * 调用示例：
 *   await copyText(await contentForCopy('text', { path: '笔记.md', markdown: '# 标题' }))
 *   const result = await exportMarkdown('html', { path: '笔记.md', markdown: '# 标题' })
 *   console.log(result.path) // 用户选定的实际保存路径
 */
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

import * as rpc from './rpc'

/** 复制支持的 4 种格式 */
export type CopyFormat = 'markdown' | 'html' | 'json' | 'text'
/** 导出支持的 4 种格式（PDF 走系统打印窗口） */
export type ExportFormat = 'markdown' | 'html' | 'json' | 'pdf'

/** 内容源：路径用于生成文件名与解析图片相对路径 */
export interface NoteSource {
  /** 工作区相对路径，如 `项目/规划.md` */
  path: string
  markdown: string
}

/** 一次导出的结果；`saved=false` 表示用户取消 */
export interface ExportOutcome {
  format: ExportFormat
  saved: boolean
  cancelled?: boolean
  /** 实际写盘的绝对路径（系统另存为时） */
  path?: string
  /** 展示用文件名 */
  filename?: string
  /** 降级为浏览器下载 */
  fallback?: boolean
  /** PDF 打印窗口已唤起 */
  printed?: boolean
}

/** 导出文件名里不允许出现的字符（Windows / macOS / Linux 交集） */
const INVALID_FILE_NAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g
/** 打印 iframe 的兜底清理时间：打印窗口可能稍晚才读完文档 */
const PRINT_FRAME_CLEANUP_MS = 60_000
/** 等待导出文档里单张图片的最长时间 */
const IMAGE_LOAD_TIMEOUT_MS = 3_000
/** 导出 HTML 的标题与正文基础样式，打印 PDF 时同样生效 */
const EXPORT_DOCUMENT_STYLES = `
  @page { size: A4; margin: 18mm 16mm 20mm; }
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #fff; color: #24292f; }
  body.dbx-note-export {
    max-width: 800px; margin: 0 auto; padding: 40px 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.65;
  }
  .dbx-note-export h1, .dbx-note-export h2, .dbx-note-export h3 { break-after: avoid-page; }
  .dbx-note-export p, .dbx-note-export li, .dbx-note-export blockquote { orphans: 3; widows: 3; }
  .dbx-note-export pre, .dbx-note-export table, .dbx-note-export img { break-inside: avoid-page; }
  .dbx-note-export pre { white-space: pre-wrap; background: #f6f8fa; padding: 12px; border-radius: 6px; }
  .dbx-note-export blockquote { border-left: 4px solid #d0d7de; margin-left: 0; padding-left: 12px; color: #57606a; }
  .dbx-note-export table { width: 100%; border-collapse: collapse; }
  .dbx-note-export th, .dbx-note-export td { border: 1px solid #d0d7de; padding: 8px 10px; }
  .dbx-note-export th { background: #f6f8fa; }
  .dbx-note-export img { max-width: 100%; height: auto; }
  .dbx-note-export a { color: #0969da; }
  @media print { body.dbx-note-export { max-width: none; padding: 0; } }
`

let markdownManager: MarkdownManager | null = null

/**
 * 净化文件名。
 * @param fileName 原始文件名（可含路径分隔符与扩展名）
 * @returns 可安全用于下载属性的名字，空输入返回 `document`
 */
export function sanitizeFileName(fileName: string): string {
  return fileName.replace(INVALID_FILE_NAME_CHARS, '_').replace(/\s+/g, ' ').trim() || 'document'
}

/**
 * 从笔记路径取不含扩展名的导出基名。
 * @param path 工作区相对路径，如 `项目/规划.md`
 */
export function exportBaseName(path: string): string {
  const name = path.split(/[\\/]/).pop() || path || 'document'
  return sanitizeFileName(name.replace(/\.[^/.\\]+$/, ''))
}

/** HTML 属性 / 标题转义，避免笔记标题破坏导出文档结构 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Markdown → 净化后的 HTML 片段（同步，纯文本复制走这条，不做图片内联） */
function renderMarkdownFragment(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}

/** 归一化 `项目/../assets/x.png` 这类路径，且不允许越出工作区 */
function normalizeRelativePath(raw: string): string {
  const parts: string[] = []
  for (const part of raw.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

/**
 * 把 HTML 里的**工作区图片**换成 data URL，导出文件脱离工作区后仍能显示。
 * 远端 http(s) 图、已经是 data:/blob: 的保持原样。
 */
async function inlineWorkspaceImages(html: string, sourcePath: string): Promise<string> {
  const template = document.createElement('template')
  template.innerHTML = html
  const images = Array.from(template.content.querySelectorAll('img'))
  const noteDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : ''

  await Promise.all(
    images.map(async (image) => {
      const src = image.getAttribute('src')
      if (!src || /^(?:data:|blob:|https?:|\/\/)/i.test(src)) return
      // 本项目图片默认写在工作区根（assets/...），也兼容相对当前笔记目录的写法
      const candidates = [normalizeRelativePath(src)]
      if (noteDir) candidates.push(normalizeRelativePath(`${noteDir}/${src}`))
      for (const candidate of candidates) {
        if (!candidate) continue
        try {
          const data = await rpc.readImage(candidate)
          image.setAttribute('src', data.dataUrl)
          return
        } catch {
          // 路径不存在时试下一个候选；全部失败就保留原 src
        }
      }
    }),
  )
  return template.innerHTML
}

/**
 * Markdown → 可导出 / 可复制的完整 HTML 片段（含图片内联）。
 * @param markdown 正文
 * @param sourcePath 当前笔记路径，用于解析相对图片；不传则跳过内联
 */
export async function renderMarkdownHtml(markdown: string, sourcePath?: string): Promise<string> {
  const fragment = renderMarkdownFragment(markdown)
  return sourcePath ? inlineWorkspaceImages(fragment, sourcePath) : fragment
}

/**
 * 拼一份可直接打开 / 打印的完整 HTML 文档。
 * @param title 文档标题（会转义）
 * @param bodyHtml 已净化的正文片段
 */
export function buildHtmlDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_DOCUMENT_STYLES}</style>
</head>
<body class="dbx-note-export">
${bodyHtml}
</body>
</html>`
}

/** Markdown → 纯文本：先渲染成 HTML，再按块级标签补换行后取文本节点 */
export function toPlainText(markdown: string): string {
  const html = renderMarkdownFragment(markdown)
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  const template = document.createElement('template')
  template.innerHTML = html
  return (template.content.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 懒构造 Markdown → Tiptap JSON 的解析器（与参考项目 `parseMarkdownToJson` 一致） */
function getMarkdownManager(): MarkdownManager {
  if (!markdownManager) {
    markdownManager = new MarkdownManager({
      extensions: [StarterKit, TaskList, TaskItem],
      indentation: { style: 'space', size: 2 },
    })
  }
  return markdownManager
}

/** Markdown → Tiptap JSON 文档字符串 */
export function toJson(markdown: string): string {
  return JSON.stringify(getMarkdownManager().parse(markdown), null, 2)
}

/**
 * 按格式生成要写入剪贴板的文本。
 * @param format 复制格式
 * @param source 当前笔记的路径与 Markdown
 */
export async function contentForCopy(format: CopyFormat, source: NoteSource): Promise<string> {
  switch (format) {
    case 'html':
      return renderMarkdownHtml(source.markdown, source.path)
    case 'json':
      return toJson(source.markdown)
    case 'text':
      return toPlainText(source.markdown)
    case 'markdown':
    default:
      return source.markdown
  }
}

/** 浏览器下载：Blob + 临时 `<a download>`，仅作为原生对话框不可用时的降级 */
export function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 从绝对路径里取文件名，用于 toast 展示 */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/**
 * 导出文本文件：优先系统另存为，取消不写盘，不支持时降级浏览器下载。
 * @returns 是否真的保存，以及实际路径
 */
async function saveTextExport(
  content: string,
  filename: string,
  extension: string,
  mime: string,
  filterName: string,
  format: ExportFormat,
): Promise<ExportOutcome> {
  const result = await rpc.saveTextFile({ defaultName: filename, extension, filterName, content })
  if (result.saved && result.path) {
    return { format, saved: true, path: result.path, filename: fileNameOf(result.path) }
  }
  if (result.cancelled) {
    return { format, saved: false, cancelled: true }
  }
  // 非 Windows 桩 / 对话框不可用：退回浏览器下载，并明确告知是降级
  downloadText(filename, content, mime)
  return { format, saved: true, filename, fallback: true }
}

/** 等一份待打印文档里的图片与字体就绪（失败或超时都继续，不阻塞打印） */
async function waitForPrintDocument(doc: Document): Promise<void> {
  await Promise.all(
    Array.from(doc.images).map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) return resolve()
          image.onload = () => resolve()
          image.onerror = () => resolve()
          window.setTimeout(resolve, IMAGE_LOAD_TIMEOUT_MS)
        }),
    ),
  )
  if (doc.fonts) {
    await Promise.race([
      doc.fonts.ready,
      new Promise<void>((resolve) => window.setTimeout(resolve, 1_000)),
    ])
  }
}

/**
 * 打开系统打印窗口（用户选择「另存为 PDF」）。
 *
 * 优先用**顶层独立窗口**：DBX 插件页跑在 iframe 里，iframe 的 `print()` 常被宿主
 * 的 sandbox / 弹窗策略静默吞掉 —— 点了 PDF 什么都没发生，随后又降级导出 HTML，
 * 用户就会以为「几种格式都导出成了 html」。顶层窗口不受 iframe 沙箱约束。
 * 顶层窗口不可用时再退回隐藏 iframe；两条路都失败才返回 false 让调用方明确降级。
 *
 * @returns 是否成功唤起打印
 */
export async function printPdf(html: string): Promise<boolean> {
  // 1) 顶层窗口，最接近参考项目 Tauri 的原生打印窗口
  let popup: Window | null = null
  try {
    popup = window.open('', '_blank', 'width=980,height=760')
  } catch {
    popup = null
  }
  if (popup) {
    try {
      const doc = popup.document
      doc.open()
      doc.write(html)
      doc.close()
      await waitForPrintDocument(doc)
      if (typeof popup.print === 'function') {
        popup.focus()
        popup.print()
        // 用户打印完（或取消）后关掉这个临时窗口，不留在标签页里
        popup.addEventListener('afterprint', () => popup?.close(), { once: true })
        window.setTimeout(() => {
          try {
            popup?.close()
          } catch {
            /* 已被用户手动关闭 */
          }
        }, PRINT_FRAME_CLEANUP_MS)
        return true
      }
    } catch {
      /* 宿主可能禁止写 popup document，继续走 iframe */
    }
    try {
      popup.close()
    } catch {
      /* ignore */
    }
  }

  // 2) 隐藏 iframe 兜底
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText =
    'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;pointer-events:none'
  document.body.appendChild(frame)
  try {
    const doc = frame.contentDocument
    const win = frame.contentWindow
    if (!doc || !win || typeof win.print !== 'function') {
      frame.remove()
      return false
    }
    doc.open()
    doc.write(html)
    doc.close()
    await waitForPrintDocument(doc)

    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      frame.remove()
    }
    win.addEventListener('afterprint', cleanup, { once: true })
    window.setTimeout(cleanup, PRINT_FRAME_CLEANUP_MS)
    win.focus()
    win.print()
    return true
  } catch {
    frame.remove()
    return false
  }
}

/** 构建导出的完整 HTML 文档（导出 HTML 与 PDF 共用） */
async function exportHtmlDocument(source: NoteSource): Promise<string> {
  const base = exportBaseName(source.path)
  return buildHtmlDocument(base, await renderMarkdownHtml(source.markdown, source.path))
}

/**
 * 导出当前笔记。
 * @param format 目标格式
 * @param source 当前笔记的路径与 Markdown
 * @returns 是否保存、`path` 实际落盘位置；取消时 `saved=false`
 */
export async function exportMarkdown(format: ExportFormat, source: NoteSource): Promise<ExportOutcome> {
  const base = exportBaseName(source.path)
  if (format === 'markdown') {
    return saveTextExport(source.markdown, `${base}.md`, 'md', 'text/markdown;charset=utf-8', 'Markdown 文件', format)
  }
  if (format === 'html') {
    return saveTextExport(
      await exportHtmlDocument(source),
      `${base}.html`,
      'html',
      'text/html;charset=utf-8',
      'HTML 文件',
      format,
    )
  }
  if (format === 'json') {
    return saveTextExport(
      toJson(source.markdown),
      `${base}.json`,
      'json',
      'application/json;charset=utf-8',
      'JSON 文件',
      format,
    )
  }
  // PDF：唤起系统打印窗口；环境不支持时导出「可打印 HTML」，
  // 用 .print.html 后缀与普通 HTML 导出区分，避免用户以为点 PDF 却导出了 HTML
  const printableHtml = await exportHtmlDocument(source)
  if (await printPdf(printableHtml)) {
    return { format, saved: true, printed: true, filename: `${base}.pdf` }
  }
  const fallback = await saveTextExport(
    printableHtml,
    `${base}.print.html`,
    'html',
    'text/html;charset=utf-8',
    '可打印 HTML 文件',
    format,
  )
  return { ...fallback, fallback: true }
}
