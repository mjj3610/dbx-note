/**
 * GitHub Alert 提示块（对齐复刻项目的 github-alert-blockquote）
 *
 * Markdown 写法与 GitHub 一致：
 *
 *   > [!NOTE]
 *   > 正文
 *
 * - 解析：给 @tiptap/markdown 注册一个 block 级 tokenizer，把 `> [!TYPE]` 开头
 *   的整段引用切成 githubAlert 节点（正文再交给块级词法器递归解析，
 *   所以提示块里可以正常放列表 / 代码 / 公式）；
 * - 序列化：还原成同一套 `> [!TYPE]` 引用写法，导出后粘贴到 GitHub 仍然生效；
 * - 输入：在引用里输入 `[!NOTE] ` 直接转成提示块（另可从 `/` 菜单插入）。
 */
import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import type { JSONContent, MarkdownParseHelpers, MarkdownRendererHelpers } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { CircleAlert, Info, Lightbulb, MessageSquareWarning, TriangleAlert } from 'lucide-react'

import { useT } from '@/lib/useT'

export const GITHUB_ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const
export type GitHubAlertType = (typeof GITHUB_ALERT_TYPES)[number]

const ALERT_RE = /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i

function normalizeType(value: unknown): GitHubAlertType {
  const upper = typeof value === 'string' ? value.toUpperCase() : ''
  return (GITHUB_ALERT_TYPES as readonly string[]).includes(upper) ? (upper as GitHubAlertType) : 'NOTE'
}

/** 每种提示块的图标与配色（贴近 GitHub 的观感） */
const ALERT_ICON: Record<GitHubAlertType, typeof Info> = {
  NOTE: Info,
  TIP: Lightbulb,
  IMPORTANT: MessageSquareWarning,
  WARNING: TriangleAlert,
  CAUTION: CircleAlert,
}

const ALERT_LABEL_KEY: Record<GitHubAlertType, string> = {
  NOTE: 'editor.alert.note',
  TIP: 'editor.alert.tip',
  IMPORTANT: 'editor.alert.important',
  WARNING: 'editor.alert.warning',
  CAUTION: 'editor.alert.caution',
}

function AlertView({ node, updateAttributes }: ReactNodeViewProps) {
  const t = useT()
  const alertType = normalizeType(node.attrs.alertType)
  const Icon = ALERT_ICON[alertType]

  return (
    <NodeViewWrapper
      className={`dbx-alert dbx-alert-${alertType.toLowerCase()}`}
      data-github-alert={alertType}
    >
      <div className="dbx-alert-head" contentEditable={false}>
        <Icon className="dbx-alert-icon" aria-hidden />
        <select
          className="dbx-alert-select"
          value={alertType}
          aria-label={t('editor.alert.type')}
          onChange={(event) => updateAttributes({ alertType: event.target.value })}
        >
          {GITHUB_ALERT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(ALERT_LABEL_KEY[type])}
            </option>
          ))}
        </select>
      </div>
      <NodeViewContent className="dbx-alert-body" />
    </NodeViewWrapper>
  )
}

export const GitHubAlert = Node.create({
  name: 'githubAlert',

  group: 'block',

  content: 'block+',

  defining: true,

  addAttributes() {
    return {
      alertType: {
        default: 'NOTE',
        parseHTML: (element) => normalizeType(element.getAttribute('data-github-alert')),
        renderHTML: (attributes) => ({ 'data-github-alert': normalizeType(attributes.alertType) }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-github-alert]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AlertView)
  },

  markdownTokenName: 'githubAlert',

  markdownTokenizer: {
    name: 'githubAlert',
    level: 'block',
    start(src: string) {
      const match = /(?:^|\n)(?=[ \t]*>[ \t]*\[!)/.exec(src)
      if (!match) return -1
      return match.index + (match[0].length > 0 && match[0].startsWith('\n') ? 1 : 0)
    },
    tokenize(src: string, _tokens, helpers) {
      const head = /^[ \t]*>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([^\n]*)(?:\n|$)/i.exec(src)
      if (!head) return undefined
      const lines = src.split('\n')
      let count = 0
      for (const line of lines) {
        // 连续的 `>` 行都算提示块正文；空行（只有 `>`）也算
        if (!/^[ \t]*>/.test(line)) break
        count += 1
      }
      if (count === 0) return undefined
      const raw = lines.slice(0, count).join('\n')
      const unquoted = lines
        .slice(0, count)
        .map((line) => line.replace(/^[ \t]*>[ \t]?/, ''))
        .join('\n')
      const body = unquoted.replace(ALERT_RE, '').replace(/^[ \t]+/, '').trim()
      const children = body ? helpers.blockTokens(`${body}\n`) : []
      return {
        type: 'githubAlert',
        raw,
        alertType: normalizeType(head[1]),
        alertTitle: head[2]?.trim() || null,
        tokens: children,
      }
    },
  },

  parseMarkdown(token, helpers: MarkdownParseHelpers) {
    const content = helpers.parseChildren(token.tokens ?? [])
    return {
      type: 'githubAlert',
      attrs: { alertType: normalizeType(token.alertType) },
      content: content.length > 0 ? content : [{ type: 'paragraph' }],
    }
  },

  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    const alertType = normalizeType(node.attrs?.alertType)
    const body = helpers.renderChildren(node.content ?? [], '\n\n').trim()
    const quoted = body
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n')
    return `> [!${alertType}]\n${quoted}`
  },

  addInputRules() {
    return [
      // 在引用里敲 `[!NOTE] ` → 整段引用变成提示块
      new InputRule({
        find: /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]$/i,
        handler: ({ state, match }) => {
          // state 是「链式状态」，state.tr 就是本次输入事务，直接在上面改写
          const tr = state.tr
          const { $from } = state.selection
          let quoteDepth = -1
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            if ($from.node(depth).type.name === 'blockquote') {
              quoteDepth = depth
              break
            }
          }
          if (quoteDepth < 0) return
          const quote = $from.node(quoteDepth)
          const quotePos = $from.before(quoteDepth)
          const alertType = normalizeType(match[1])
          const body: JSONContent[] = []
          quote.forEach((child) => {
            if (child.type.name === 'paragraph') {
              const text = child.textContent.replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, '').trim()
              if (text) body.push({ type: 'paragraph', content: [{ type: 'text', text }] })
            } else {
              body.push(child.toJSON())
            }
          })
          if (body.length === 0) body.push({ type: 'paragraph' })
          const next = state.schema.nodes.githubAlert.create(
            { alertType },
            state.schema.nodeFromJSON({ type: 'doc', content: body }).content,
          )
          tr.replaceWith(quotePos, quotePos + quote.nodeSize, next)
          // 光标落到提示块正文起点
          const caret = Math.min(quotePos + 2, tr.doc.content.size)
          tr.setSelection(TextSelection.near(tr.doc.resolve(caret)))
        },
      }),
    ]
  },
})
