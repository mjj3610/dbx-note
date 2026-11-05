/**
 * 表格浮动工具栏（对齐复刻项目 table-context-toolbar）
 *
 * 光标进入表格时浮在表格上方，分四组：行 / 列 / 对齐 / 删表。
 * - 用 createPortal 挂到 body + fixed 定位，避免被单元格或 .tableWrapper 的 overflow 裁掉
 * - 提示统一朝上（side="top"），不会再压住表头
 * - 对齐按钮按当前单元格 align 高亮，不可用动作置灰
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Editor } from '@tiptap/core'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  TableColumnsSplit,
  TableRowsSplit,
  Trash2,
} from 'lucide-react'

import { Hint, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'

/** 浮层与视口边缘 / 表格之间的留白 */
const MENU_EDGE_GAP = 8

type Align = 'left' | 'center' | 'right'

interface Position {
  left: number
  top: number
  visible: boolean
}

/** 找到选区所在表格的外框（对齐参考项目的 .tableWrapper 逻辑） */
function tableFrame(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection
  let pos: number | null = null
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') {
      pos = $from.before(depth)
      break
    }
  }
  if (pos == null) return null
  const node = editor.view.nodeDOM(pos)
  if (!(node instanceof HTMLElement)) return null
  const table = node.matches('table') ? node : node.querySelector('table')
  if (!table) return null
  return table.closest<HTMLElement>('.tableWrapper') ?? table
}

/** 编辑器所在滚动视口（找不到就退化成整窗） */
function editorViewport(editor: Editor): HTMLElement | null {
  const dom = editor.view.dom
  return (
    dom.closest<HTMLElement>('[data-editor-viewport-root="true"]') ??
    dom.closest<HTMLElement>('.editor-scroll-container') ??
    dom.closest<HTMLElement>('[data-scroll-root="true"]')
  )
}

export function TableFloatingBar({ editor }: { editor: Editor; containerRef?: React.RefObject<HTMLDivElement | null> }) {
  const t = useT()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position>({ left: 0, top: 0, visible: false })
  const [, setTick] = useState(0)

  const active = !editor.isDestroyed && editor.isEditable && editor.isActive('table')
  const alignment = (editor.isDestroyed
    ? 'left'
    : editor.getAttributes('tableCell').align ?? editor.getAttributes('tableHeader').align ?? 'left') as Align

  /** 选区 / 文档变化后重算（顺带刷新按钮可用态与高亮） */
  const sync = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (editor.isDestroyed) return
    const onSync = () => queueMicrotask(sync)
    editor.on('transaction', onSync)
    editor.on('focus', onSync)
    editor.on('selectionUpdate', onSync)
    document.addEventListener('scroll', onSync, true)
    window.addEventListener('resize', onSync)
    onSync()
    return () => {
      editor.off('transaction', onSync)
      editor.off('focus', onSync)
      editor.off('selectionUpdate', onSync)
      document.removeEventListener('scroll', onSync, true)
      window.removeEventListener('resize', onSync)
    }
  }, [editor, sync])

  // 每次渲染后量一次位置；值没变就不 setState，避免死循环
  useLayoutEffect(() => {
    if (!active || editor.isDestroyed) {
      setPosition((current) => (current.visible ? { ...current, visible: false } : current))
      return
    }
    const menu = menuRef.current
    const frame = tableFrame(editor)
    if (!menu || !frame) return
    const height = menu.offsetHeight
    const bounds = frame.getBoundingClientRect()
    const viewport = editorViewport(editor)
    const viewportBounds = viewport?.getBoundingClientRect()
    const minLeft = Math.max(0, viewportBounds?.left ?? 0) + MENU_EDGE_GAP
    const right = Math.min(window.innerWidth, viewportBounds?.right ?? window.innerWidth) - MENU_EDGE_GAP
    menu.style.maxWidth = `${Math.max(0, right - minLeft)}px`
    const left = Math.max(minLeft, Math.min(bounds.left, right - menu.offsetWidth))
    const minTop = Math.max(0, viewportBounds?.top ?? 0) + MENU_EDGE_GAP
    const bottom = Math.min(window.innerHeight, viewportBounds?.bottom ?? window.innerHeight) - MENU_EDGE_GAP
    const maxTop = Math.max(minTop, bottom - height)
    // 默认浮在表格上方；上方放不下就落到表格顶部内侧
    const top = Math.max(minTop, Math.min(bounds.top - height - MENU_EDGE_GAP, maxTop))
    const visible =
      bounds.right > minLeft && bounds.left < right && bounds.bottom > minTop && bounds.top < bottom
    setPosition((current) =>
      current.left === left && current.top === top && current.visible === visible
        ? current
        : { left, top, visible },
    )
  })

  if (!active) return null

  const run = (action: () => void) => () => {
    action()
    requestAnimationFrame(sync)
  }

  const setAlign = (value: Align) => () => {
    editor.chain().focus().setCellAttribute('align', value).run()
    requestAnimationFrame(sync)
  }

  const item = (
    key: string,
    label: string,
    icon: React.ReactNode,
    action: () => void,
    options: { danger?: boolean; active?: boolean; disabled?: boolean } = {},
  ) => (
    <Hint key={key} label={label} side="top" sideOffset={6}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={options.active}
        disabled={options.disabled}
        data-table-action={key}
        onMouseDown={(event) => {
          if (event.button === 0) event.preventDefault()
        }}
        onClick={run(action)}
        className={cn('size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground')}
      >
        <span
          className={cn(
            'flex items-center justify-center',
            options.danger && 'text-destructive',
            options.active && 'text-primary',
          )}
        >
          {icon}
        </span>
      </Button>
    </Hint>
  )

  const separator = (key: string) => (
    <span key={key} className="mx-0.5 flex h-5 shrink-0 items-center">
      <span className="h-full w-px bg-border" />
    </span>
  )

  return createPortal(
    <div
      ref={menuRef}
      data-table-toolbar
      className="fixed z-50 flex flex-wrap items-center gap-0.5 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{
        left: position.left,
        top: position.top,
        visibility: position.visible ? 'visible' : 'hidden',
      }}
    >
      <TooltipProvider delayDuration={300}>
        {/* 行 */}
        {item('addRowBefore', t('editor.table.addRowBefore'), <BetweenHorizontalStart className="size-3.5" />, () =>
          editor.chain().focus().addRowBefore().run(),
        { disabled: !editor.can().addRowBefore() })}
        {item('addRowAfter', t('editor.table.addRowAfter'), <BetweenHorizontalEnd className="size-3.5" />, () =>
          editor.chain().focus().addRowAfter().run(),
        { disabled: !editor.can().addRowAfter() })}
        {item('deleteRow', t('editor.table.deleteRow'), <TableRowsSplit className="size-3.5" />, () =>
          editor.chain().focus().deleteRow().run(),
        { danger: true, disabled: !editor.can().deleteRow() })}
        {separator('sep-row')}
        {/* 列 */}
        {item('addColumnBefore', t('editor.table.addColumnBefore'), <BetweenVerticalStart className="size-3.5" />, () =>
          editor.chain().focus().addColumnBefore().run(),
        { disabled: !editor.can().addColumnBefore() })}
        {item('addColumnAfter', t('editor.table.addColumnAfter'), <BetweenVerticalEnd className="size-3.5" />, () =>
          editor.chain().focus().addColumnAfter().run(),
        { disabled: !editor.can().addColumnAfter() })}
        {item('deleteColumn', t('editor.table.deleteColumn'), <TableColumnsSplit className="size-3.5" />, () =>
          editor.chain().focus().deleteColumn().run(),
        { danger: true, disabled: !editor.can().deleteColumn() })}
        {separator('sep-col')}
        {/* 对齐 */}
        {item('alignLeft', t('editor.alignLeft'), <AlignLeft className="size-3.5" />, setAlign('left'), {
          active: alignment === 'left',
        })}
        {item('alignCenter', t('editor.alignCenter'), <AlignCenter className="size-3.5" />, setAlign('center'), {
          active: alignment === 'center',
        })}
        {item('alignRight', t('editor.alignRight'), <AlignRight className="size-3.5" />, setAlign('right'), {
          active: alignment === 'right',
        })}
        {separator('sep-align')}
        {/* 删表 */}
        {item('deleteTable', t('editor.table.deleteTable'), <Trash2 className="size-3.5" />, () =>
          editor.chain().focus().deleteTable().run(),
        { danger: true, disabled: !editor.can().deleteTable() })}
      </TooltipProvider>
    </div>,
    editor.view.dom.ownerDocument.body,
  )
}
