/**
 * Mermaid 图表节点（与 NoteGen v0.39.2 的 `mermaid-extension.tsx` 对齐）
 *
 * 行为：
 * - Markdown 侧是普通围栏代码块 ```mermaid，注册 tokenizer 后解析成图表节点，
 *   存回文件仍是同一段围栏代码，别的编辑器打开不会看到任何私有格式；
 * - 预览用 mermaid 渲染成 SVG；点击预览切到源码编辑（可选图类型 / Ctrl+Enter 完成 / Esc 取消）；
 * - 渲染串行排队：mermaid 内部维护全局状态，并发 render 会串图；
 * - 主题跟随界面深浅色，避免默认浅色主题在暗色界面上看不清。
 */
import { mergeAttributes, Node, type MarkdownTokenizer } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { Check, Code2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '@/lib/useT'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'

/** 支持的图类型（顺序与斜杠菜单一致） */
export const MERMAID_TYPES = [
  'flowchart',
  'sequence',
  'classDiagram',
  'stateDiagram',
  'er',
  'gantt',
  'pie',
  'journey',
] as const

export type MermaidType = (typeof MERMAID_TYPES)[number]

/** 各类型的中英文模板：插入命令时直接给出可渲染的示例 */
export const MERMAID_TEMPLATES: Record<MermaidType, { zh: string; en: string }> = {
  flowchart: {
    zh: 'graph TD\n    A[开始] --> B[处理]\n    B --> C[结束]',
    en: 'graph TD\n    A[Start] --> B[Process]\n    B --> C[End]',
  },
  sequence: {
    zh: 'sequenceDiagram\n    participant Alice\n    participant Bob\n    Alice->>Bob: 你好\n    Bob-->>Alice: 回复',
    en: 'sequenceDiagram\n    participant Alice\n    participant Bob\n    Alice->>Bob: Hello\n    Bob-->>Alice: Reply',
  },
  classDiagram: {
    zh: 'classDiagram\n    Animal <|-- Duck\n    Animal <|-- Fish\n    Animal : +int age\n    Animal : +String gender',
    en: 'classDiagram\n    Animal <|-- Duck\n    Animal <|-- Fish\n    Animal : +int age\n    Animal : +String gender',
  },
  stateDiagram: {
    zh: 'stateDiagram-v2\n    [*] --> 进行中\n    进行中 --> [*]',
    en: 'stateDiagram-v2\n    [*] --> Active\n    Active --> [*]',
  },
  er: {
    zh: 'erDiagram\n    CUSTOMER ||--o{ ORDER : 下单\n    CUSTOMER ||--o{ ADDRESS : 使用',
    en: 'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    CUSTOMER ||--o{ ADDRESS : uses',
  },
  gantt: {
    zh: 'gantt\n    title 项目计划\n    dateFormat YYYY-MM-DD\n    section 第一阶段\n    任务1 :a1, 2024-01-01, 30d\n    section 第二阶段\n    任务2 :after a1, 20d',
    en: 'gantt\n    title Project Plan\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Task1 :a1, 2024-01-01, 30d\n    section Phase 2\n    Task2 :after a1, 20d',
  },
  pie: {
    zh: 'pie title 资源分配\n    "CPU" : 45\n    "内存" : 30\n    "存储" : 25',
    en: 'pie title Resource Allocation\n    "CPU" : 45\n    "Memory" : 30\n    "Storage" : 25',
  },
  journey: {
    zh: 'journey\n    title 我的一天\n    section 上午\n    通勤 : 7:00, 5\n    工作 : 9:00, 8',
    en: 'journey\n    title My Day\n    section Morning\n    Commute : 7:00, 5\n    Work : 9:00, 8',
  },
}

/** 取模板（按界面语言） */
export function mermaidTemplate(type: string, zh: boolean): string {
  const key = (MERMAID_TYPES as readonly string[]).includes(type) ? (type as MermaidType) : 'flowchart'
  return zh ? MERMAID_TEMPLATES[key].zh : MERMAID_TEMPLATES[key].en
}

/** 首行关键字 → 图类型（与参考实现同一套别名） */
const DIAGRAM_ALIASES: ReadonlyArray<readonly [MermaidType, readonly string[]]> = [
  ['flowchart', ['flowchart', 'graph td', 'graph bt', 'graph lr', 'graph rl', 'graph']],
  ['sequence', ['sequence', 'sequencediagram']],
  ['classDiagram', ['class', 'classdiagram']],
  ['stateDiagram', ['state', 'statediagram', 'statediagram-v2']],
  ['er', ['er', 'erdiagram']],
  ['gantt', ['gantt']],
  ['pie', ['pie']],
  ['journey', ['journey', 'gitgraph']],
]

/** 从源码首行推断类型，识别不出按流程图处理 */
export function detectMermaidDiagramType(code: string): MermaidType {
  const trimmed = code.trimStart()
  const newline = trimmed.indexOf('\n')
  const firstLine = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trimEnd().toLowerCase()
  for (const [type, aliases] of DIAGRAM_ALIASES) {
    if (aliases.some((alias) => firstLine === alias || firstLine.startsWith(`${alias} `))) return type
  }
  return 'flowchart'
}

const mermaidTokenizer: MarkdownTokenizer = {
  name: 'mermaid',
  level: 'block',
  start: (source) => {
    const match = source.match(/^```mermaid\r?\n/)
    return match ? (match.index ?? -1) : -1
  },
  tokenize: (source) => {
    const match = /^```mermaid\r?\n([\s\S]*?)\r?\n```/.exec(source)
    if (!match) return undefined
    const code = match[1]
    return {
      type: 'mermaid',
      raw: match[0],
      content: code,
      attrs: { type: detectMermaidDiagramType(code) },
      tokens: [],
    }
  },
}

type MermaidApi = (typeof import('mermaid'))['default']

let mermaidPromise: Promise<MermaidApi> | null = null
let renderSeq = 0
/** mermaid 内部有全局状态，渲染必须串行 */
let renderQueue: Promise<unknown> = Promise.resolve()
let themeInUse = ''

async function getMermaid(theme: 'default' | 'dark'): Promise<MermaidApi> {
  const mermaid = mermaidPromise
    ? await mermaidPromise
    : await (mermaidPromise = import('mermaid').then(({ default: instance }) => instance))

  if (themeInUse !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: 'loose',
      fontFamily: 'inherit',
      suppressErrorRendering: true,
    })
    themeInUse = theme
  }
  return mermaid
}

/** 渲染成 SVG；`shouldRender` 用于丢弃已经过期的结果 */
async function renderMermaid(
  code: string,
  theme: 'default' | 'dark',
  shouldRender: () => boolean,
): Promise<string | null> {
  const run = async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    if (!shouldRender()) return null
    const mermaid = await getMermaid(theme)
    if (!shouldRender()) return null
    const { svg } = await mermaid.render(`dbx-mermaid-${++renderSeq}`, code)
    return svg
  }
  const result = renderQueue.then(run, run)
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return await result
}

/** 跟随界面深浅色：切换主题时旧的 SVG 主题不对，需要重画 */
function useDarkAppearance(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    const sync = () => setDark(document.documentElement.classList.contains('dark'))
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-appearance', 'data-dbx-theme'],
    })
    sync()
    return () => observer.disconnect()
  }, [])
  return dark
}

function MermaidView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const t = useT()
  const zh = useSettingsStore((state) => state.locale.startsWith('zh'))
  const dark = useDarkAppearance()
  const code = String(node.attrs.code ?? '')
  const diagramType = String(node.attrs.type ?? 'flowchart') as MermaidType

  // 空图表直接进编辑态，省掉"点一下才能输入"的一步
  const [editing, setEditing] = useState(() => code.trim() === '')
  const [draft, setDraft] = useState(code)
  const [draftType, setDraftType] = useState<MermaidType>(diagramType)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const versionRef = useRef(0)

  const draw = useCallback(async () => {
    const version = ++versionRef.current
    if (!code.trim()) {
      setSvg('')
      setError(null)
      setRendering(false)
      return
    }
    setError(null)
    setRendering(true)
    try {
      const rendered = await renderMermaid(code, dark ? 'dark' : 'default', () => versionRef.current === version)
      if (rendered === null || versionRef.current !== version) return
      setSvg(rendered)
    } catch (cause) {
      if (versionRef.current !== version) return
      setSvg('')
      setError(cause instanceof Error ? cause.message : t('editor.mermaid.renderError'))
    } finally {
      if (versionRef.current === version) setRendering(false)
    }
  }, [code, dark, t])

  useEffect(() => {
    if (editing) return
    void draw()
    return () => {
      versionRef.current++
    }
  }, [draw, editing])

  // 外部改动（撤销 / 同步刷新）回填到草稿
  useEffect(() => {
    if (editing) return
    setDraft(code)
    setDraftType(diagramType)
  }, [code, diagramType, editing])

  const commit = () => {
    const nextCode = draft
    setEditing(false)
    if (nextCode !== code || draftType !== diagramType) {
      updateAttributes({ code: nextCode, type: draftType })
    }
  }

  const cancel = () => {
    setDraft(code)
    setDraftType(diagramType)
    setEditing(false)
  }

  const startEditing = () => {
    if (!editor.isEditable) return
    setDraft(code)
    setDraftType(diagramType)
    setEditing(true)
  }

  return (
    <NodeViewWrapper
      className={cn('my-3', selected && 'rounded-lg ring-2 ring-primary/40')}
      data-mermaid-block={diagramType}
    >
      {editing ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-2 py-1.5">
            <select
              aria-label={t('editor.mermaid.title')}
              value={draftType}
              onChange={(event) => {
                const next = event.target.value as MermaidType
                setDraftType(next)
                // 空源码时顺带填好该类型的示例，避免选完还是空白
                if (!draft.trim()) setDraft(mermaidTemplate(next, zh))
              }}
              className="h-7 rounded border border-border bg-background px-1.5 text-xs outline-none"
            >
              {MERMAID_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`editor.mermaid.diagramTypes.${type}`)}
                </option>
              ))}
            </select>
            <span className="flex-1" />
            <button
              type="button"
              title={t('editor.mermaid.done')}
              aria-label={t('editor.mermaid.done')}
              onClick={commit}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          </div>
          <textarea
            value={draft}
            aria-label={t('editor.mermaid.placeholder')}
            placeholder={t('editor.mermaid.placeholder')}
            spellCheck={false}
            rows={8}
            onChange={(event) => setDraft(event.target.value)}
            onCopyCapture={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
                return
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                commit()
              }
            }}
            className="block max-h-80 min-h-32 w-full resize-y border-0 bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed outline-none"
          />
          {error ? (
            <div className="border-t border-border bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          data-mermaid-preview=""
          onClick={startEditing}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              startEditing()
            }
          }}
          className="group relative cursor-pointer overflow-x-auto rounded-lg border border-border bg-card"
        >
          {error ? (
            <div className="p-3 text-xs text-destructive">
              <p className="font-medium">{t('editor.mermaid.renderError')}</p>
              <p className="mt-1 whitespace-pre-wrap break-all opacity-80">{error}</p>
              <p className="mt-2 text-muted-foreground">{t('editor.mermaid.clickToEdit')}</p>
            </div>
          ) : svg ? (
            <div
              className="mermaid-svg flex justify-center p-3"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : rendering ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {t('editor.mermaid.rendering')}
            </div>
          ) : (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {t('editor.mermaid.clickToAdd')}
            </div>
          )}
          <span className="pointer-events-none absolute right-2 top-2 rounded bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            <Code2 className="h-3.5 w-3.5" />
          </span>
        </div>
      )}
    </NodeViewWrapper>
  )
}

/** Mermaid 图表块（```mermaid 围栏） */
export const MermaidDiagram = Node.create({
  name: 'mermaidDiagram',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-code') ?? '',
        renderHTML: (attributes) => ({ 'data-code': attributes.code }),
      },
      type: {
        default: 'flowchart',
        parseHTML: (element) => element.getAttribute('data-mermaid-type') ?? 'flowchart',
        renderHTML: (attributes) => ({ 'data-mermaid-type': attributes.type }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="mermaid-diagram"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mermaid-diagram' })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidView)
  },

  markdownTokenName: 'mermaid',
  markdownTokenizer: mermaidTokenizer,

  parseMarkdown: (token) => {
    const code = token.content ?? ''
    return {
      type: 'mermaidDiagram',
      attrs: { code, type: detectMermaidDiagramType(code) },
    }
  },

  renderMarkdown: (node) => `\n\`\`\`mermaid\n${String(node.attrs?.code ?? '')}\n\`\`\`\n`,
})

export default MermaidDiagram
