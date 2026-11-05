/**
 * 图片尺寸属性工具
 *
 * Markdown 里图片有两种写法（与 NoteGen 一致）：
 * - 无尺寸：`![alt](src)`
 * - 有尺寸：`<img src="…" alt="…" width="400" height="300">`
 *
 * 因此 `width` / `height` 可能是数字（面板写入）、字符串（Markdown / HTML 解析回来
 * 的都是字符串，还可能是 `"400px"`），也可能是 `null`（重置尺寸）。
 * 这里统一收敛成"正整数或 null"，序列化与面板输入共用同一套判定。
 */

/** 把节点属性里的尺寸值解析成正整数像素，无效值一律返回 null */
export function parseImageDimension(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null
  }
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?(?:px)?$/i.test(trimmed)) return null

  const parsed = Number.parseInt(trimmed.replace(/px$/i, ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** 面板输入框的值转尺寸：空串表示"不限制" */
export function parseDimensionInput(value: string): number | null {
  return value.trim() ? parseImageDimension(value) : null
}

/** HTML 属性转义（src / alt / title 会拼进 `<img …>` 字符串） */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 图片节点的 Markdown 序列化
 *
 * 无尺寸走原生语法（干净、可被任何 Markdown 编辑器识别）；
 * 有尺寸才退化成内联 HTML——这是 GFM 表达图片宽高的唯一方式，
 * 也是参考项目 `Image.extend({ renderMarkdown })` 的做法。
 */
export function imageMarkdown(attrs: Record<string, unknown>): string {
  const src = String(attrs.src ?? '')
  const alt = String(attrs.alt ?? '')
  const title = attrs.title ? String(attrs.title) : ''
  const width = parseImageDimension(attrs.width)
  const height = parseImageDimension(attrs.height)

  if (!width && !height) {
    return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`
  }

  const parts = [`src="${escapeHtmlAttribute(src)}"`, `alt="${escapeHtmlAttribute(alt)}"`]
  if (title) parts.push(`title="${escapeHtmlAttribute(title)}"`)
  if (width) parts.push(`width="${width}"`)
  if (height) parts.push(`height="${height}"`)
  return `<img ${parts.join(' ')}>`
}
