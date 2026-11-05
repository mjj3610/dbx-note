/**
 * 代码块视图：语言选择 + 一键复制
 *
 * 与 NoteGen v0.39.2 的 `code-block-view.tsx` 对齐的能力面：
 * - 右上角浮出工具条，可选择语言（写回 ```lang 围栏，Auto 表示不指定）；
 * - 复制按钮拷走整块源码，成功后短暂显示对勾；
 * - 工具条自身不可编辑（contentEditable=false），点击不会把光标插进代码。
 *
 * 语法高亮仍由 CodeBlockLowlight 的装饰插件负责，因此这里只换渲染外壳。
 */
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { copyText } from '@/lib/bridge'
import { useT } from '@/lib/useT'

/** Auto 用空值表示：围栏写成 ``` 而不是 ```auto */
const AUTO = ''

/** 语言清单（与参考实现同一套取值，去掉其插件预览相关的扩展） */
export const CODE_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: AUTO, label: 'Auto' },
  { value: 'plaintext', label: 'Plain Text' },
  { value: 'bash', label: 'Bash' },
  { value: 'shell', label: 'Shell' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'css', label: 'CSS' },
  { value: 'diff', label: 'Diff' },
  { value: 'go', label: 'Go' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'html', label: 'HTML' },
  { value: 'ini', label: 'INI' },
  { value: 'java', label: 'Java' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'json', label: 'JSON' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'less', label: 'Less' },
  { value: 'lua', label: 'Lua' },
  { value: 'makefile', label: 'Makefile' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'objectivec', label: 'Objective-C' },
  { value: 'perl', label: 'Perl' },
  { value: 'php', label: 'PHP' },
  { value: 'python', label: 'Python' },
  { value: 'r', label: 'R' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'rust', label: 'Rust' },
  { value: 'scss', label: 'SCSS' },
  { value: 'sql', label: 'SQL' },
  { value: 'swift', label: 'Swift' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'yaml', label: 'YAML' },
]

function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const t = useT()
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : AUTO
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  // 自定义语言（文件里写了清单外的值）也要能显示出来
  const options = CODE_LANGUAGES.some((item) => item.value === language)
    ? CODE_LANGUAGES
    : [...CODE_LANGUAGES, { value: language, label: language }]

  const copy = async () => {
    const done = await copyText(node.textContent)
    if (!done) return
    setCopied(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1200)
    // 复制后把焦点还给编辑器，用户可以接着打字
    requestAnimationFrame(() => {
      if (!editor.isDestroyed) editor.commands.focus()
    })
  }

  return (
    <NodeViewWrapper className="code-block-wrapper relative" data-code-block={language || 'auto'}>
      <div
        className="absolute right-2 top-2 z-10 flex items-center gap-1.5"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <select
          aria-label={t('editor.codeLanguage')}
          title={t('editor.codeLanguage')}
          value={language}
          onChange={(event) => updateAttributes({ language: event.target.value || null })}
          className="h-[26px] max-w-32 rounded border border-border/70 bg-background/80 px-1 font-mono text-[11px] text-muted-foreground outline-none hover:text-foreground"
        >
          {options.map((item) => (
            <option key={item.value || 'auto'} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          title={copied ? t('editor.codeCopied') : t('editor.codeCopy')}
          aria-label={copied ? t('editor.codeCopied') : t('editor.codeCopy')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void copy()}
          className="flex size-[26px] items-center justify-center rounded border border-border/70 bg-background/80 text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      {/* 顶部留出工具条高度，代码不被遮住 */}
      <pre style={{ paddingTop: '2.5rem' }}>
        <code>
          <NodeViewContent />
        </code>
      </pre>
    </NodeViewWrapper>
  )
}

/** 带语言选择器的代码块（替换默认 CodeBlockLowlight） */
export const CodeBlockWithToolbar = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView)
  },
})

export default CodeBlockWithToolbar
