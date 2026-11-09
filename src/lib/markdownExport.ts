/**
 * 笔记「复制 / 导出」的纯工具层（对齐参考项目 footer-bar 的 4 种复制 + 4 种导出格式）
 *
 * 调用示例：
 *   const md = '# 标题\n正文'
 *   await copyText(contentForCopy('text', md))                    // 复制纯文本
 *   const { filename, content, mime } = contentForExport('html', md, '笔记.md')
 *   downloadText(filename, content, mime)                         // 导出 HTML
 *   await printPdf(buildHtmlDocument('笔记', renderMarkdownHtml(md))) // 导出 PDF
 *
 * 注意：Markdown 源文本一律取 `useNotesStore.content`，可视化编辑器与源码模式共用同一份，
 * 所以这里不需要持有 Tiptap Editor 实例。
 */
import DOMPurify from 'dompurify'
import { marked } from 'marked'

/** 复制支持的 4 种格式 */
export type CopyFormat = 'markdown' | 'html' | 'json' | 'text'
/** 导出支持的 4 种格式（PDF 走系统打印窗口） */
export type ExportFormat = 'markdown' | 'html' | 'json' | 'pdf'

/** 导出文件名里不允许出现的字符（Windows / macOS / Linux 交集） */
const INVALID_FILE_NAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g
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
/** 打印 iframe 的兜底清理时间：打印窗口可能稍晚才读完文档 */
const PRINT_FRAME_CLEANUP_MS = 60_000
/** 等待导出文档里单张图片的最长时间 */
const IMAGE_LOAD_TIMEOUT_MS = 3_000

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

/**
 * Markdown → 净化后的 HTML 片段。
 * `marked` 默认同步解析；DOMPurify 去掉脚本、事件属性等，导出文件不允许带可执行内容。
 */
export function renderMarkdownHtml(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
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

/**
 * Markdown → 纯文本：先渲染成 HTML，再按块级标签补换行后取文本节点。
 */
export function toPlainText(markdown: string): string {
  const html = renderMarkdownHtml(markdown)
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  const template = document.createElement('template')
  template.innerHTML = html
  return (template.content.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Markdown → 结构化 JSON（marked 的词法 token 树），便于其它程序消费。
 */
export function toJson(markdown: string): string {
  return JSON.stringify(marked.lexer(markdown), null, 2)
}

/**
 * 按格式生成要写入剪贴板的文本。
 * @param format 复制格式
 * @param markdown 当前笔记 Markdown 源文本
 */
export function contentForCopy(format: CopyFormat, markdown: string): string {
  switch (format) {
    case 'html':
      return renderMarkdownHtml(markdown)
    case 'json':
      return toJson(markdown)
    case 'text':
      return toPlainText(markdown)
    case 'markdown':
    default:
      return markdown
  }
}

/**
 * 按格式生成下载文件（PDF 不在本函数内，走 `printPdf`）。
 * @param format 导出格式
 * @param markdown 当前笔记 Markdown 源文本
 * @param path 当前笔记路径，用于生成文件名
 * @returns 文件名、内容与 MIME；文件名已带对应扩展名
 */
export function contentForExport(
  format: Exclude<ExportFormat, 'pdf'>,
  markdown: string,
  path: string,
): { filename: string; content: string; mime: string } {
  const base = exportBaseName(path)
  switch (format) {
    case 'html':
      return {
        filename: `${base}.html`,
        content: buildHtmlDocument(base, renderMarkdownHtml(markdown)),
        mime: 'text/html;charset=utf-8',
      }
    case 'json':
      return {
        filename: `${base}.json`,
        content: toJson(markdown),
        mime: 'application/json;charset=utf-8',
      }
    case 'markdown':
    default:
      return {
        filename: `${base}.md`,
        content: markdown,
        mime: 'text/markdown;charset=utf-8',
      }
  }
}

/**
 * 浏览器下载：Blob + 临时 `<a download>`，用完立刻释放 URL。
 * 与截图浮层的下载路径一致，在插件沙箱里已验证可用。
 */
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

/** 等一张图片加载完（失败或超时都继续，不阻塞导出） */
function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve()
  return new Promise((resolve) => {
    image.onload = () => resolve()
    image.onerror = () => resolve()
    window.setTimeout(resolve, IMAGE_LOAD_TIMEOUT_MS)
  })
}

/**
 * 用隐藏 iframe 打开系统打印窗口（用户选择「另存为 PDF」）。
 * 沙箱若禁止 iframe 打印则返回 false，调用方应提示改用「导出 HTML」。
 * @param html `buildHtmlDocument()` 的完整文档
 * @returns 是否成功唤起打印
 */
export async function printPdf(html: string): Promise<boolean> {
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
    await Promise.all(Array.from(doc.images).map(waitForImage))
    if (doc.fonts) await doc.fonts.ready
    win.focus()
    win.print()
    window.setTimeout(() => frame.remove(), PRINT_FRAME_CLEANUP_MS)
    return true
  } catch {
    frame.remove()
    return false
  }
}
