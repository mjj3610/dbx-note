/**
 * 文字颜色 / 高亮颜色选择器（选中文字后气泡工具条里的两枚按钮）
 *
 * 定位说明：面板不用 Radix 下拉的锚点定位。
 * 气泡工具条（BubbleMenu）在点开下拉后会因选区变化而收起，触发器尺寸塌成 0，
 * 锚点随之跑到 (0,0)，面板就会飘到文档左上角、甚至超出编辑器。
 * 这里改为「打开瞬间记录按钮自身的矩形」，面板用 `position: fixed` 自己定位，
 * 即便触发器随后被隐藏，面板也停在原处。
 *
 * 另外下拉面板会抢焦点，因此打开时先把选区存下来，选色后再恢复选区并套用 mark，
 * 否则颜色只会作用到丢失选区后的光标位置。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { Highlighter, Type } from 'lucide-react'

import { cn } from '@/lib/utils'
import { COLOR_NAMES, HIGHLIGHT_COLORS, TEXT_COLORS, normalizeTextColor } from '@/lib/textColors'
import { useT } from '@/lib/useT'

/** 面板尺寸（估算，用于边界收敛与上下翻转） */
const PANEL_WIDTH = 148
const PANEL_HEIGHT = 244
const GAP = 6

interface Anchor {
  top: number
  left: number
}

export function ColorMenu({ editor, highlight = false }: { editor: Editor; highlight?: boolean }) {
  const t = useT()
  const mark = highlight ? 'highlight' : 'textColor'
  const colors = highlight ? HIGHLIGHT_COLORS : TEXT_COLORS
  const Icon = highlight ? Highlighter : Type
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<Anchor>({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const saved = useRef<{ from: number; to: number; doc: unknown } | null>(null)

  const current = normalizeTextColor(editor.getAttributes(mark).color)
  const active = editor.isActive(mark)
  const indicator = current ?? (highlight ? 'transparent' : 'currentColor')

  const apply = (color: string | null) => {
    setOpen(false)
    const selection = saved.current
    if (!selection || editor.isDestroyed) return
    const chain = editor.chain().focus()
    if (selection.doc === editor.state.doc) {
      chain.setTextSelection({ from: selection.from, to: selection.to })
    }
    if (color) chain.setMark(mark, { color }).run()
    else chain.unsetMark(mark).run()
  }

  /** 以按钮自身矩形为锚：默认贴按钮下方，下方放不下则翻到上方，左右做边界收敛 */
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return false
    const below = rect.bottom + GAP
    const flip = below + PANEL_HEIGHT > window.innerHeight - 8
    const top = flip ? rect.top - PANEL_HEIGHT - GAP : below
    const left = Math.min(
      Math.max(8, rect.left - 4),
      Math.max(8, window.innerWidth - PANEL_WIDTH - 8),
    )
    setAnchor({ top: Math.max(8, top), left })
    return true
  }, [])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const { from, to } = editor.state.selection
    saved.current = { from, to, doc: editor.state.doc }
    if (!place()) return
    setOpen(true)
  }

  // 点面板外 / Esc / 滚动改变布局时关闭，避免面板挂在已移走的位置上
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      const panel = document.querySelector('[data-color-panel]')
      if (panel?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }
    const onReflow = () => setOpen(false)
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

  const rowClass =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t(highlight ? 'editor.highlightColor' : 'editor.textColor')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t(highlight ? 'editor.highlightColor' : 'editor.textColor')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className={cn(toolClass, (active || open) && 'bg-muted text-foreground')}
      >
        <Icon className="size-3.5" />
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute bottom-0.5 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full',
            highlight && !current && 'bg-primary/40',
          )}
          style={highlight && !current ? undefined : { backgroundColor: indicator }}
        />
      </button>

      {/* 面板挂到 body：气泡工具条收起时会整块隐藏，留在里面会跟着消失 */}
      {open
        ? createPortal(
            <div
              data-color-panel
              role="menu"
              aria-label={t(highlight ? 'editor.highlightColor' : 'editor.textColor')}
              onMouseDown={(event) => event.preventDefault()}
              className="fixed z-50 overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
              style={{ top: anchor.top, left: anchor.left, width: PANEL_WIDTH }}
            >
              <button type="button" role="menuitem" className={rowClass} onClick={() => apply(null)}>
                {t('editor.colorClear')}
              </button>
              {highlight ? (
                <button type="button" role="menuitem" className={rowClass} onClick={() => apply('#fef08a')}>
                  {t('editor.highlightDefault')}
                </button>
              ) : null}
              <div className="-mx-1 my-1 h-px bg-border" />
              {colors.map((color, index) => (
                <button
                  key={color}
                  type="button"
                  role="menuitem"
                  data-color={color}
                  className={rowClass}
                  onClick={() => apply(color)}
                >
                  <span
                    aria-hidden="true"
                    className="size-3.5 shrink-0 rounded-sm border border-border"
                    style={{ backgroundColor: color }}
                  />
                  {t(`editor.colors.${COLOR_NAMES[index]}`)}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

const toolClass =
  'relative flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
