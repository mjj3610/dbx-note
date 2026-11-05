/**
 * 选中文字后的 AI 菜单（气泡工具条最左侧的星标按钮）
 *
 * 分组与参考实现一致：润色 / 精简 / 扩展 ｜ 从选区生成画布（流程图、思维导图、
 * 时间线、任务关系）｜ 翻译（常用语言 + 自定义）。
 *
 * 定位沿用 ColorMenu 的做法：打开瞬间记录按钮矩形，面板用 `position: fixed`
 * 自定义定位并挂到 body——气泡工具条会随选区变化整块卸载，锚点定位会飘到 (0,0)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import {
  BrainCircuit,
  ChevronRight,
  Languages,
  ListTodo,
  Maximize2,
  Minimize2,
  Sparkles,
  Timer,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'

import * as rpc from '@/lib/rpc'
import {
  TRANSLATE_LANGUAGES,
  languageLabel,
  type SelectionAIAction,
} from '@/lib/selectionAI'
import { buildCanvasFromText, type CanvasFromSelectionKind } from '@/lib/selectionCanvas'
import { useCanvasStore } from '@/stores/canvas'
import { useSelectionAIStore } from '@/stores/selectionAI'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'

const PANEL_WIDTH = 208
const PANEL_HEIGHT = 372
const SUBMENU_WIDTH = 168
const GAP = 6

const AI_ACTIONS: Array<{ action: SelectionAIAction; icon: typeof Sparkles; key: string }> = [
  { action: 'polish', icon: Sparkles, key: 'editor.ai.polish' },
  { action: 'concise', icon: Minimize2, key: 'editor.ai.concise' },
  { action: 'expand', icon: Maximize2, key: 'editor.ai.expand' },
]

const CANVAS_KINDS: Array<{
  kind: CanvasFromSelectionKind
  icon: typeof Sparkles
  key: string
}> = [
  { kind: 'flowchart', icon: Workflow, key: 'editor.ai.flowchart' },
  { kind: 'mindmap', icon: BrainCircuit, key: 'editor.ai.mindmap' },
  { kind: 'timeline', icon: Timer, key: 'editor.ai.timeline' },
  { kind: 'tasks', icon: ListTodo, key: 'editor.ai.tasks' },
]

/** 选区纯文本（段间用换行，避免把段落粘成一行） */
function selectedText(editor: Editor): string {
  const { from, to } = editor.state.selection
  if (from === to) return ''
  return editor.state.doc.textBetween(from, to, '\n', '\n')
}

/** 从选区生成一份画布并打开 */
async function createCanvasFromSelection(
  editor: Editor,
  kind: CanvasFromSelectionKind,
  fallbackTitle: string,
): Promise<string> {
  const text = selectedText(editor)
  const built = buildCanvasFromText(text, kind, fallbackTitle)
  const created = await rpc.canvasCreate(built.title)
  const doc = {
    version: 1,
    title: built.title,
    nodes: built.nodes,
    edges: built.edges,
    updatedAt: Date.now(),
  }
  await rpc.canvasSave(created.path, JSON.stringify(doc))
  const canvas = useCanvasStore.getState()
  await canvas.loadList()
  await canvas.open(created.path)
  useUiStore.getState().setTab('canvases')
  return built.title
}

export function SelectionAIMenu({ editor }: { editor: Editor }) {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const zh = locale.startsWith('zh')
  const [open, setOpen] = useState(false)
  const [translateOpen, setTranslateOpen] = useState(false)
  const [customLang, setCustomLang] = useState('')
  const [anchor, setAnchor] = useState({ top: 0, left: 0 })
  const [flipSubmenu, setFlipSubmenu] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return false
    const below = rect.bottom + GAP
    const flip = below + PANEL_HEIGHT > window.innerHeight - 8
    const top = flip ? Math.max(8, rect.top - PANEL_HEIGHT - GAP) : below
    const left = Math.min(
      Math.max(8, rect.left - 6),
      Math.max(8, window.innerWidth - PANEL_WIDTH - 8),
    )
    setAnchor({ top, left })
    // 右侧放不下子菜单就翻到左边
    setFlipSubmenu(left + PANEL_WIDTH + SUBMENU_WIDTH + GAP > window.innerWidth - 8)
    return true
  }, [])

  const close = () => {
    setOpen(false)
    setTranslateOpen(false)
    setCustomLang('')
  }

  const toggle = () => {
    if (open) {
      close()
      return
    }
    if (!selectedText(editor).trim()) {
      toast.warning(t('editor.ai.noSelection'))
      return
    }
    if (!place()) return
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (document.querySelector('[data-selection-ai-menu]')?.contains(target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    }
    const onReflow = () => close()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open])

  const runAI = (action: SelectionAIAction, language?: string) => {
    const text = selectedText(editor)
    if (!text.trim()) {
      toast.warning(t('editor.ai.noSelection'))
      close()
      return
    }
    const { from, to } = editor.state.selection
    const coords = editor.view.coordsAtPos(to)
    close()
    void useSelectionAIStore.getState().start({
      action,
      text,
      language,
      from,
      to,
      doc: editor.state.doc,
      anchor: { top: coords.bottom + 8, left: coords.left },
    })
  }

  const runCanvas = (kind: CanvasFromSelectionKind) => {
    const label = t(CANVAS_KINDS.find((item) => item.kind === kind)?.key ?? 'canvas.new')
    close()
    void createCanvasFromSelection(editor, kind, label)
      .then((title) => toast.success(t('editor.ai.canvasCreated', { title })))
      .catch((error: unknown) =>
        toast.error(
          `${t('editor.ai.canvasFailed')}：${error instanceof Error ? error.message : String(error)}`,
        ),
      )
  }

  const rowClass =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-muted'
  const sectionClass = 'px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('editor.ai.title')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('editor.ai.title')}
        data-selection-ai
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className={cn(
          'flex size-6 items-center justify-center rounded text-primary transition-colors hover:bg-muted',
          open && 'bg-muted',
        )}
      >
        <Sparkles className="size-3.5" />
      </button>
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />

      {open
        ? createPortal(
            <div
              data-selection-ai-menu
              role="menu"
              aria-label={t('editor.ai.title')}
              onMouseDown={(event) => event.preventDefault()}
              className="fixed z-50 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
              style={{ top: anchor.top, left: anchor.left, width: PANEL_WIDTH }}
            >
              {AI_ACTIONS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  data-ai-action={item.action}
                  className={rowClass}
                  onClick={() => runAI(item.action)}
                >
                  <item.icon className="size-3.5 shrink-0 text-muted-foreground" />
                  {t(item.key)}
                </button>
              ))}

              <div className="-mx-1 my-1 h-px bg-border" />
              <p className={sectionClass}>{t('editor.ai.generateCanvas')}</p>
              {CANVAS_KINDS.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  role="menuitem"
                  data-ai-canvas={item.kind}
                  className={rowClass}
                  onClick={() => runCanvas(item.kind)}
                >
                  <item.icon className="size-3.5 shrink-0 text-muted-foreground" />
                  {t(item.key)}
                </button>
              ))}

              <div className="-mx-1 my-1 h-px bg-border" />

              <div
                className="relative"
                onMouseEnter={() => setTranslateOpen(true)}
                onMouseLeave={() => setTranslateOpen(false)}
              >
                <button
                  type="button"
                  role="menuitem"
                  data-ai-translate
                  aria-expanded={translateOpen}
                  className={cn(rowClass, translateOpen && 'bg-muted')}
                  onClick={() => setTranslateOpen((current) => !current)}
                >
                  <Languages className="size-3.5 shrink-0 text-muted-foreground" />
                  {t('editor.ai.translate')}
                  <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
                </button>

                {translateOpen ? (
                  <div
                    data-ai-translate-menu
                    role="menu"
                    aria-label={t('editor.ai.translate')}
                    className={cn(
                      'absolute top-0 max-h-72 overflow-y-auto rounded-lg bg-popover p-1 shadow-md ring-1 ring-foreground/10',
                      flipSubmenu ? 'right-full mr-1' : 'left-full ml-1',
                    )}
                    style={{ width: SUBMENU_WIDTH }}
                  >
                    {TRANSLATE_LANGUAGES.map((lang) => (
                      <button
                        key={lang.code}
                        type="button"
                        role="menuitem"
                        data-ai-lang={lang.code}
                        className={rowClass}
                        onClick={() => runAI('translate', languageLabel(lang.key, zh))}
                      >
                        {t(`editor.ai.languages.${lang.key}`)}
                      </button>
                    ))}
                    <div className="-mx-1 my-1 h-px bg-border" />
                    <div className="px-1 pb-1">
                      <input
                        value={customLang}
                        onChange={(event) => setCustomLang(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            const value = customLang.trim()
                            if (!value) return
                            setCustomLang('')
                            runAI('translate', value)
                          }
                          if (event.key === 'Escape') {
                            setTranslateOpen(false)
                            setCustomLang('')
                          }
                        }}
                        placeholder={t('editor.ai.customLanguage')}
                        aria-label={t('editor.ai.customLanguage')}
                        className="h-7 w-full rounded border border-border bg-background px-2 text-xs outline-none focus:border-ring/60"
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
