/**
 * 数学公式节点（行内 `$…$` / 块级 `$$…$$`）
 *
 * 渲染用 KaTeX 的 MathML 输出（`output: 'mathml'`）：
 * Chromium 原生支持 MathML Core，因此**不需要**额外的 katex.css 与字体文件，
 * 在 `default-src 'none'` 的沙箱里也不会因为字体被拦而变形。
 *
 * 编辑方式：点击公式切换成文本域，`Enter` 提交、`Shift+Enter` 换行、`Esc` 取消；
 * Markdown 侧注册了 tokenizer，因此存回文件后仍是 `$…$` / `$$…$$`。
 */
import { Node, type MarkdownTokenizer } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import katex from 'katex'
import { useEffect, useRef, useState } from 'react'

import { MATH_EXAMPLES } from '@/lib/mathExamples'
import { useT } from '@/lib/useT'
import { cn } from '@/lib/utils'

/** LaTeX → MathML 字符串；语法错误时退化为纯文本，避免把错误抛到渲染层 */
function renderMath(latex: string, displayMode: boolean): { html: string; error: boolean } {
  const source = latex.trim()
  if (!source) return { html: '', error: false }
  try {
    const html = katex.renderToString(source, {
      displayMode,
      output: 'mathml',
      throwOnError: true,
      strict: false,
    })
    return { html, error: false }
  } catch {
    return { html: '', error: true }
  }
}

/** 公式编辑器：文本域 + 实时预览 + 常用公式提示（行内 / 块级共用） */
function MathEditor({
  value,
  displayMode,
  onCommit,
  onCancel,
}: {
  value: string
  displayMode: boolean
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  const t = useT()
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  const preview = renderMath(draft, displayMode)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.focus()
    element.select()
  }, [])

  /** 把示例插到光标处（有选中内容则替换），随后聚焦回去 */
  const insertExample = (latex: string) => {
    const element = ref.current
    if (!element) {
      setDraft((current) => current + latex)
      return
    }
    const start = element.selectionStart ?? draft.length
    const end = element.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + latex + draft.slice(end)
    setDraft(next)
    requestAnimationFrame(() => {
      element.focus()
      const caret = start + latex.length
      element.setSelectionRange(caret, caret)
    })
  }

  return (
    <span className={cn('block space-y-1', displayMode ? 'w-full' : 'w-64')}>
      {preview.html ? (
        <span
          className="block overflow-x-auto rounded bg-muted/40 px-2 py-1"
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
      ) : null}
      <textarea
        ref={ref}
        value={draft}
        aria-label="LaTeX"
        spellCheck={false}
        rows={displayMode ? 3 : 1}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onCommit(draft)
          }
        }}
        className={cn(
          'w-full resize-y rounded border border-border bg-background px-2 py-1 font-mono text-[12px] outline-none',
          displayMode && 'min-h-16',
        )}
      />
      {/* 常用公式提示：mousedown 阻止默认行为，点示例不会让 textarea 失焦提交 */}
      <span className="block">
        <span className="mb-1 block text-[11px] text-muted-foreground">{t('math.examples')}</span>
        <span className="flex flex-wrap gap-1">
          {MATH_EXAMPLES.map((item) => (
            <button
              key={item.label}
              type="button"
              data-math-chip={item.label}
              title={item.latex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertExample(item.latex)}
              className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              {item.label}
            </button>
          ))}
        </span>
      </span>
    </span>
  )
}

function MathView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const [editing, setEditing] = useState(false)
  const latex = String(node.attrs.latex ?? '')
  const displayMode = node.type.name === 'blockMath'
  const { html, error } = renderMath(latex, displayMode)

  const commit = (next: string) => {
    setEditing(false)
    if (next !== latex) updateAttributes({ latex: next })
  }

  return (
    <NodeViewWrapper
      as={displayMode ? 'div' : 'span'}
      className={cn(
        displayMode ? 'my-2 block' : 'inline-block align-middle',
        selected && 'rounded ring-1 ring-primary/40',
      )}
    >
      {editing ? (
        <MathEditor
          value={latex}
          displayMode={displayMode}
          onCommit={commit}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span
          role="button"
          tabIndex={0}
          title={latex}
          data-math={displayMode ? 'block' : 'inline'}
          onClick={() => {
            if (editor.isEditable) setEditing(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && editor.isEditable) {
              event.preventDefault()
              setEditing(true)
            }
          }}
          className={cn(
            'cursor-pointer rounded px-1 hover:bg-muted/60',
            displayMode && 'block overflow-x-auto py-1 text-center',
            error && 'text-destructive',
          )}
          {...(html ? { dangerouslySetInnerHTML: { __html: html } } : { children: latex || '空公式' })}
        />
      )}
    </NodeViewWrapper>
  )
}

const inlineMathTokenizer: MarkdownTokenizer = {
  name: 'inline_math',
  level: 'inline',
  start: (source) => {
    const dollar = source.indexOf('$')
    const bracket = source.indexOf('\\(')
    if (dollar === -1) return bracket
    if (bracket === -1) return dollar
    return Math.min(dollar, bracket)
  },
  tokenize: (source) => {
    const match = /^(?:\$([^$\n]+?)\$|\\\(([^\n]+?)\\\))/.exec(source)
    if (!match) return undefined
    return {
      type: 'inline_math',
      raw: match[0],
      content: match[1] ?? match[2] ?? '',
      tokens: [],
    }
  },
}

const blockMathTokenizer: MarkdownTokenizer = {
  name: 'block_math',
  level: 'block',
  start: (source) => {
    const dollar = source.indexOf('$$')
    const bracket = source.indexOf('\\[')
    if (dollar === -1) return bracket
    if (bracket === -1) return dollar
    return Math.min(dollar, bracket)
  },
  tokenize: (source) => {
    const match = /^(?:\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\])/.exec(source)
    if (!match) return undefined
    return {
      type: 'block_math',
      raw: match[0],
      content: (match[1] ?? match[2] ?? '').trim(),
      tokens: [],
    }
  },
}

/** 行内公式 `$E = mc^2$` */
export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? element.textContent ?? '',
        renderHTML: (attributes) => ({ 'data-latex': attributes.latex }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-latex]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-math': 'inline' }]
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathView)
  },
  markdownTokenizer: inlineMathTokenizer,
  parseMarkdown: (token, helpers) => ({
    type: 'inlineMath',
    attrs: { latex: token.content ?? '' },
    content: helpers.parseInline(token.tokens || []) as never,
  }),
  renderMarkdown: (node) => `$${String(node.attrs?.latex ?? '')}$`,
})

/** 块级公式 `$$ … $$` */
export const BlockMath = Node.create({
  name: 'blockMath',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? element.textContent ?? '',
        renderHTML: (attributes) => ({ 'data-latex': attributes.latex }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-latex]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-math': 'block' }]
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathView)
  },
  markdownTokenizer: blockMathTokenizer,
  parseMarkdown: (token) => ({
    type: 'blockMath',
    attrs: { latex: token.content ?? '' },
  }),
  renderMarkdown: (node) => `$$\n${String(node.attrs?.latex ?? '')}\n$$`,
})
