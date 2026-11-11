import { useEffect, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'

/** 与设计令牌对齐的 CodeMirror 主题，跟随深浅色变量 */
const sourceTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'hsl(var(--foreground))',
    fontSize: 'var(--dbx-note-source-size, 14px)',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: 'var(--dbx-note-mono)',
    padding: '24px 0 40vh',
    caretColor: 'hsl(var(--primary))',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'hsl(var(--muted-foreground))',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'hsl(var(--muted) / 0.4)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'hsl(var(--primary) / 0.14) !important',
  },
  '.cm-cursor': { borderLeftColor: 'hsl(var(--primary))' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.7' },
})

/**
 * Markdown 源码模式
 *
 * 直接编辑原始文本，适合粘贴结构化内容或微调语法。
 * 行号与自动换行跟随「设置 → 编辑器」里的开关。
 */
export function SourceEditor({
  value,
  onChange,
  lineNumbers = true,
  wrap = true,
  readOnly = false,
}: {
  value: string
  onChange: (next: string) => void
  lineNumbers?: boolean
  wrap?: boolean
  /** 右键「只读打开」：源码视图同样禁止编辑 */
  readOnly?: boolean
}) {
  const extensions = [
    markdown({ base: markdownLanguage }),
    sourceTheme,
    ...(wrap ? [EditorView.lineWrapping] : []),
  ]
  /** 源码模式下大纲点击按行号定位（可视化模式由 Tiptap 按 pos 定位） */
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    const handler = (event: Event) => {
      const line = Number((event as CustomEvent<number>).detail)
      const view = viewRef.current
      if (!view || !Number.isFinite(line) || line < 0) return
      const number = Math.min(Math.max(1, line + 1), view.state.doc.lines)
      const target = view.state.doc.line(number)
      view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true })
      view.focus()
    }
    window.addEventListener('dbx-note:scroll-to-line', handler)
    return () => window.removeEventListener('dbx-note:scroll-to-line', handler)
  }, [])

  return (
    <CodeMirror
      value={value}
      onCreateEditor={(view) => {
        viewRef.current = view
      }}
      onChange={onChange}
      editable={!readOnly}
      extensions={extensions}
      basicSetup={{
        lineNumbers,
        foldGutter: false,
        highlightActiveLine: true,
        highlightActiveLineGutter: false,
        bracketMatching: true,
        autocompletion: false,
      }}
      height="100%"
      className="h-full"
    />
  )
}
