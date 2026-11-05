/**
 * 图片设置面板（对齐 NoteGen 的 `image-bubble-menu`）
 *
 * 点击正文里的图片弹出，可改地址 / 替代文本 / 宽高，支持重置尺寸与删除。
 *
 * 两个实现要点：
 * 1. **不用 BubbleMenu**：BubbleMenu 只认文本选区，图片是 atom 节点（NodeSelection），
 *    且需要在图片旁常驻显示。参考项目也是给 `editor.view.dom` 挂原生 click，
 *    这里用 `posAtDOM` 直接换算节点位置，比逐个 `doc.descendants` 比 src 更稳
 *    （本地图会被代理成 data URL，src 对不上）。
 * 2. **尺寸只在面板里写**：无尺寸 → `![alt](src)`；有尺寸 → `<img … width height>`，
 *    序列化规则见 `lib/imageAttrs.ts`，与参考项目一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { Check, RotateCcw, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { parseDimensionInput, parseImageDimension } from '@/lib/imageAttrs'

/** 面板与编辑器容器的间距 / 最大宽度 */
const EDGE_PX = 12
const MAX_WIDTH = 420
const MIN_WIDTH = 200

interface Box {
  left: number
  top: number
  width: number
}

interface Info {
  pos: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** 向上找第一个纵向可滚动的祖先（编辑器外层滚动容器） */
function findScrollParent(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null
  while (node) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
    node = node.parentElement
  }
  return null
}

/**
 * 找到点击位置对应的图片节点位置
 *
 * `posAtDOM(image, 0)` 给的是"节点起点"，但不同嵌套层级可能落在节点前或节点后，
 * 因此前后各探一次；都落空再退化成按 src 比对。
 */
function imagePosAt(editor: Editor, image: HTMLImageElement): number | null {
  const view = editor.view
  const doc = view.state.doc

  let pos: number | null = null
  try {
    pos = view.posAtDOM(image, 0)
  } catch {
    pos = null
  }

  if (pos !== null) {
    const safe = Math.min(Math.max(pos, 0), doc.content.size)
    const $pos = doc.resolve(safe)
    if ($pos.nodeAfter?.type.name === 'image') return $pos.pos
    if ($pos.nodeBefore?.type.name === 'image') return $pos.pos - $pos.nodeBefore.nodeSize
    if (doc.nodeAt(safe)?.type.name === 'image') return safe
  }

  // 兜底：本地图渲染时被换成 data URL，比对时优先用 data-src 里的原始路径
  const target = image.getAttribute('data-src') ?? image.getAttribute('src') ?? ''
  if (!target) return null
  let found: number | null = null
  doc.descendants((node, position) => {
    if (found !== null) return false
    if (node.type.name !== 'image') return true
    const src = String(node.attrs.src ?? '')
    if (src && (src === target || target.endsWith(src))) {
      found = position
      return false
    }
    return true
  })
  return found
}

export function ImageSettingPanel({
  editor,
  containerRef,
}: {
  editor: Editor
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const t = useT()
  const [info, setInfo] = useState<Info | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  const [srcText, setSrcText] = useState('')
  const [altText, setAltText] = useState('')
  const [widthText, setWidthText] = useState('')
  const [heightText, setHeightText] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const posRef = useRef<number | null>(null)

  const measure = useCallback(() => {
    const pos = posRef.current
    const container = containerRef.current
    if (pos === null || !container) {
      setBox(null)
      return
    }
    const node = editor.isDestroyed ? null : editor.view.nodeDOM(pos)
    const image = node instanceof HTMLImageElement ? node : null
    if (!image || !image.isConnected) {
      setBox(null)
      return
    }

    const rect = image.getBoundingClientRect()
    const base = container.getBoundingClientRect()
    const scroller = findScrollParent(container)
    const view = scroller
      ? scroller.getBoundingClientRect()
      : new DOMRect(0, 0, window.innerWidth, window.innerHeight)
    // 整张图滚出可视区就不画了（状态保留，滚回来再出现）
    if (rect.bottom < view.top || rect.top > view.bottom) {
      setBox(null)
      return
    }

    const width = Math.min(MAX_WIDTH, view.width - EDGE_PX * 2)
    if (width < MIN_WIDTH) {
      setBox(null)
      return
    }

    const centerX = rect.left - base.left + rect.width / 2
    const left = clamp(
      centerX - width / 2,
      EDGE_PX,
      Math.min(base.width - width - EDGE_PX, Math.max(EDGE_PX, view.right - base.left - width - EDGE_PX)),
    )

    const menuHeight = menuRef.current?.offsetHeight ?? 300
    const minTop = view.top - base.top + EDGE_PX
    const maxTop = view.bottom - base.top - menuHeight - EDGE_PX
    // 图片可能比可视区高，取"可见部分"的中心对齐面板
    const visibleTop = Math.max(rect.top, view.top)
    const visibleBottom = Math.min(rect.bottom, view.bottom)
    const centerY = (visibleTop + visibleBottom) / 2 - base.top
    const top = clamp(centerY - menuHeight / 2, minTop, maxTop)

    setBox({ left, top, width })
  }, [containerRef, editor])

  const close = useCallback(() => {
    posRef.current = null
    setInfo(null)
    setBox(null)
    setSrcText('')
    setAltText('')
    setWidthText('')
    setHeightText('')
  }, [])

  /** 点击图片 → 选中节点并读出属性 */
  const onEditorClick = useCallback(
    (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const image = target.closest('img')
      if (!(image instanceof HTMLImageElement)) return
      if (!editor.view.dom.contains(image)) return

      const pos = imagePosAt(editor, image)
      if (pos === null) return
      const node = editor.state.doc.nodeAt(pos)
      if (!node || node.type.name !== 'image') return

      editor.chain().setNodeSelection(pos).run()
      posRef.current = pos
      setInfo({ pos })
      setAltText(String(node.attrs.alt ?? ''))
      setSrcText(String(node.attrs.src ?? ''))
      setWidthText(String(parseImageDimension(node.attrs.width) ?? Math.round(image.getBoundingClientRect().width)))
      setHeightText(String(parseImageDimension(node.attrs.height) ?? Math.round(image.getBoundingClientRect().height)))
      window.requestAnimationFrame(measure)
    },
    [editor, measure],
  )

  // 点击面板外 / 编辑器里别处 → 收起
  useEffect(() => {
    if (!info) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target)) return
      if (target instanceof HTMLElement && target.closest('img')) return
      // 顶部工具栏（BubbleMenu 等）里的操作不关面板，否则点一下就没了
      if (target instanceof HTMLElement && target.closest('[data-editor-toolbar], [data-slash-menu]')) return
      close()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [close, info])

  // 选区离开该图片 → 收起（键盘移动光标等）
  useEffect(() => {
    if (!info) return
    const onSelection = () => {
      const { selection } = editor.state
      if (selection instanceof NodeSelection && selection.from === info.pos) return
      close()
    }
    editor.on('selectionUpdate', onSelection)
    return () => {
      editor.off('selectionUpdate', onSelection)
    }
  }, [close, editor, info])

  // 滚动 / 尺寸变化时重新定位
  useEffect(() => {
    if (!info) return
    const update = () => window.requestAnimationFrame(measure)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    editor.on('update', update)
    update()
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      editor.off('update', update)
    }
  }, [editor, info, measure])

  useEffect(() => {
    const dom = editor.view.dom
    dom.addEventListener('click', onEditorClick)
    return () => dom.removeEventListener('click', onEditorClick)
  }, [editor, onEditorClick])

  const save = useCallback(() => {
    const pos = posRef.current
    const source = srcText.trim()
    if (pos === null || !source) return
    editor
      .chain()
      .setNodeSelection(pos)
      .updateAttributes('image', {
        src: source,
        alt: altText,
        width: parseDimensionInput(widthText),
        height: parseDimensionInput(heightText),
      })
      .run()
    close()
  }, [altText, close, editor, heightText, srcText, widthText])

  const resetSize = useCallback(() => {
    const pos = posRef.current
    if (pos === null) return
    editor.chain().setNodeSelection(pos).updateAttributes('image', { width: null, height: null }).run()
    // 重置后回到图片原始像素尺寸
    const node = editor.view.nodeDOM(pos)
    const image = node instanceof HTMLImageElement ? node : null
    setWidthText(image ? String(Math.round(image.getBoundingClientRect().width)) : '')
    setHeightText(image ? String(Math.round(image.getBoundingClientRect().height)) : '')
    window.requestAnimationFrame(measure)
  }, [editor, measure])

  const remove = useCallback(() => {
    const pos = posRef.current
    if (pos === null) return
    editor.chain().focus().deleteRange({ from: pos, to: pos + 1 }).run()
    close()
  }, [close, editor])

  if (!info || !box) return null

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  const field = (
    id: string,
    label: string,
    value: string,
    setValue: (next: string) => void,
    options?: { placeholder?: string; type?: 'number' },
  ) => (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-[0.7rem] font-medium text-muted-foreground">{label}</span>
      <Input
        id={id}
        value={value}
        type={options?.type}
        min={options?.type === 'number' ? 1 : undefined}
        step={options?.type === 'number' ? 1 : undefined}
        placeholder={options?.placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(event) => event.target.select()}
        className="h-7 text-xs"
      />
    </label>
  )

  return (
    <div
      ref={menuRef}
      data-editor-image-menu
      className={cn(
        'absolute z-40 rounded-xl bg-popover/95 p-3 text-popover-foreground shadow-lg',
        'ring-1 ring-foreground/10 backdrop-blur',
      )}
      style={{ left: box.left, top: box.top, width: box.width }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{t('editor.image.settings')}</div>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t('editor.image.cancel')} onClick={close}>
          <X />
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {field('image-src', t('editor.image.source'), srcText, setSrcText, {
          placeholder: t('editor.image.srcPlaceholder'),
        })}
        {field('image-alt', t('editor.image.alt'), altText, setAltText, {
          placeholder: t('editor.image.altPlaceholder'),
        })}
        <div className="grid grid-cols-2 gap-2">
          {field('image-width', t('editor.image.widthPlaceholder'), widthText, setWidthText, { type: 'number' })}
          {field('image-height', t('editor.image.heightPlaceholder'), heightText, setHeightText, { type: 'number' })}
        </div>

        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={resetSize}>
              <RotateCcw />
              {t('editor.image.resetSize')}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={remove}>
              <Trash2 />
              {t('editor.image.deleteShort')}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              <X />
              {t('editor.image.cancel')}
            </Button>
            <Button type="button" size="sm" disabled={!srcText.trim()} onClick={save}>
              <Check />
              {t('editor.image.confirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
