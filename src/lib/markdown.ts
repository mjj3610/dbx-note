import { Marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * 轻量 Markdown 渲染（AI 消息、预览）
 *
 * - 使用 marked 解析，DOMPurify 消毒，避免模型输出注入脚本；
 * - 沙箱 CSP 禁止外部资源，渲染结果只保留文本、表格、代码等本地元素。
 */
const parser = new Marked({
  gfm: true,
  breaks: true,
})

export function renderMarkdown(source: string): string {
  if (!source) return ''
  try {
    const html = parser.parse(source, { async: false }) as string
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel'],
    })
  } catch {
    // 解析失败时退化为纯文本，保证内容可见
    return DOMPurify.sanitize(source.replace(/[<>]/g, ''))
  }
}
