/**
 * 文字颜色 / 高亮色色板（与 NoteGen `src/lib/text-colors.ts` 同一组色值）
 *
 * 只接受固定的十六进制色值，不做任意 CSS 透传，避免 markdown 里出现无法校验的样式。
 */
export const TEXT_COLORS = ['#c24141', '#b76518', '#92721a', '#348358', '#377ac2', '#9960bf'] as const
export const HIGHLIGHT_COLORS = ['#fecaca', '#fed7aa', '#fef08a', '#bbf7d0', '#bfdbfe', '#e9d5ff'] as const

/** 颜色名（用于无障碍标签与提示） */
export const COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const

export type TextColorValue = (typeof TEXT_COLORS)[number]
export type HighlightColorValue = (typeof HIGHLIGHT_COLORS)[number]

/**
 * 归一化颜色：只接受 `#rrggbb` 与 `rgb(r, g, b)`
 *
 * 任何其它写法（命名色、hsl、带 `url()` 的值）都返回 null，渲染时直接丢弃。
 */
export function normalizeTextColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase()
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/i.exec(value)
  if (!rgb || rgb.slice(1).some((part) => Number(part) > 255)) return null
  return `#${rgb
    .slice(1)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`
}
