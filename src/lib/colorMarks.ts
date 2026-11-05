/**
 * 带颜色的行内标记
 *
 * - `TextColor`：文字颜色（`<span data-dbx-color>`）；
 * - `ColorHighlight`：高亮底色（`<mark data-dbx-color>`，无色时退回 `==文本==`）。
 *
 * 两者都注册了 `markdownTokenizer / parseMarkdown / renderMarkdown`，
 * 因此颜色能原样写进 Markdown 再读回来（沙箱里没有 HTML 剪贴板往返）。
 */
import { Mark, getExtensionField, type MarkdownTokenizer } from '@tiptap/core'
import Highlight from '@tiptap/extension-highlight'

import { normalizeTextColor } from '@/lib/textColors'

/** 颜色标记在 Markdown 里用的属性名 */
const COLOR_ATTR = 'data-dbx-color'

/**
 * 颜色 tokenizer：识别 `<span data-dbx-color="#rrggbb" …>` / `<mark …>` 包裹的内容
 *
 * 用配对计数而不是非贪婪正则，保证嵌套同色内容不会被提前截断；
 * 行内代码里的尖括号先跳过，避免把代码里的标签当成标记。
 */
function colorTokenizer(name: string, tag: 'span' | 'mark'): MarkdownTokenizer {
  return {
    name,
    level: 'inline',
    start: (source) => source.indexOf(`<${tag} ${COLOR_ATTR}=`),
    tokenize(source, _tokens, helpers) {
      const opening = new RegExp(`^<${tag} ${COLOR_ATTR}="(#[0-9a-fA-F]{6})"(?: style="[^"<>]*")?>`).exec(source)
      if (!opening) return undefined
      const tags = new RegExp('`+|<\\/?' + tag + '\\b[^>]*>', 'g')
      tags.lastIndex = opening[0].length
      let depth = 1
      for (let match = tags.exec(source); match; match = tags.exec(source)) {
        if (match[0].startsWith('`')) {
          const closing = new RegExp('(?<!`)' + match[0] + '(?!`)', 'g')
          closing.lastIndex = tags.lastIndex
          const end = closing.exec(source)
          if (end) tags.lastIndex = closing.lastIndex
          continue
        }
        depth += match[0].startsWith('</') ? -1 : 1
        if (depth !== 0) continue
        return {
          type: name,
          raw: source.slice(0, tags.lastIndex),
          color: opening[1].toLowerCase(),
          tokens: helpers.inlineTokens(source.slice(opening[0].length, match.index)),
        }
      }
      return undefined
    },
  }
}

/** 文字颜色标记 */
export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) =>
          normalizeTextColor(element.getAttribute(COLOR_ATTR) || element.style.color),
        renderHTML: (attributes) => {
          const color = normalizeTextColor(attributes.color)
          return color ? { [COLOR_ATTR]: color, style: `color: ${color}` } : {}
        },
      },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'span',
        getAttrs: (element) => {
          const node = element as HTMLElement
          return normalizeTextColor(node.getAttribute(COLOR_ATTR) || node.style.color) ? {} : false
        },
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0]
  },
  markdownTokenizer: colorTokenizer('textColor', 'span'),
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('textColor', helpers.parseInline(token.tokens || []), {
      color: normalizeTextColor(token.color),
    }),
  renderMarkdown(node, helpers) {
    const color = normalizeTextColor(node.attrs?.color)
    const content = helpers.renderChildren(node)
    return color
      ? `<span ${COLOR_ATTR}="${color}" style="color: ${color}">${content}</span>`
      : content
  },
})

const defaultHighlightTokenizer = getExtensionField<MarkdownTokenizer>(Highlight, 'markdownTokenizer')
const coloredHighlightTokenizer = colorTokenizer('highlight', 'mark')

/** 高亮标记（支持自定义底色，无色时用 GFM 的 `==文本==`） */
export const ColorHighlight = Highlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      color: {
        default: null,
        parseHTML: (element) =>
          normalizeTextColor(element.getAttribute(COLOR_ATTR) || element.style.backgroundColor),
        renderHTML: (attributes) => {
          const color = normalizeTextColor(attributes.color)
          return color ? { [COLOR_ATTR]: color } : {}
        },
      },
    }
  },
  renderHTML({ mark, HTMLAttributes }) {
    const color = normalizeTextColor(mark.attrs.color)
    return [
      'mark',
      color
        ? { ...HTMLAttributes, [COLOR_ATTR]: color, style: `background-color: ${color}; color: #1f2937` }
        : HTMLAttributes,
      0,
    ]
  },
  markdownTokenizer: {
    ...(defaultHighlightTokenizer as MarkdownTokenizer),
    start: (source: string) => {
      const positions = [source.indexOf('=='), source.indexOf(`<mark ${COLOR_ATTR}=`)].filter(
        (index) => index >= 0,
      )
      return positions.length ? Math.min(...positions) : -1
    },
    tokenize: (source, tokens, helpers) =>
      coloredHighlightTokenizer.tokenize(source, tokens, helpers) ||
      (defaultHighlightTokenizer as MarkdownTokenizer).tokenize(source, tokens, helpers),
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('highlight', helpers.parseInline(token.tokens || []), {
      color: normalizeTextColor(token.color),
    }),
  renderMarkdown(node, helpers) {
    const color = normalizeTextColor(node.attrs?.color)
    const content = helpers.renderChildren(node)
    return color
      ? `<mark ${COLOR_ATTR}="${color}" style="background-color: ${color}; color: #1f2937">${content}</mark>`
      : `==${content}==`
  },
})
