/**
 * 截图浮层（快捷键 / 编辑器按钮唤起）
 *
 * 流程对齐参考实现：抓一张整屏 → 浮层里框选区域 → 用矩形/椭圆/箭头/画笔/文字/马赛克标注
 * → 复制到系统剪贴板、下载、保存到记录或插入笔记。
 *
 * 与前几版的差别：以前是「读剪贴板 / 整屏 → 直接插入」，用户无法选区域、也无法标注。
 *
 * 坐标说明：整屏图按窗口等比缩放显示（不放大），选区与标注都记在显示坐标系里，
 * 导出时统一按 naturalWidth / 显示宽 还原到原始像素，所以成品永远是屏幕真实分辨率。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  Check,
  Circle,
  Copy,
  Download,
  Loader2,
  MousePointer2,
  Pencil,
  Pin,
  Redo2,
  ScanLine,
  Square,
  Type,
  Undo2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import * as rpc from '@/lib/rpc'
import {
  SHOT_COLORS,
  SHOT_TOOLS,
  SHOT_WIDTHS,
  clampPoint,
  composeStage,
  cropSelection,
  paintScene,
  pointInRect,
  rectFromPoints,
  type Annotation,
  type Point,
  type Rect,
  type ShotTool,
} from '@/lib/screenshotEditor'
import { insertCapturedImage, saveCapturedImage, saveShotToRecords, stampName } from '@/lib/screenshot'
import { cn, localId } from '@/lib/utils'
import { useScreenshotStore } from '@/stores/screenshot'
import { useT } from '@/lib/useT'

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLES: Array<{ handle: Handle; x: number; y: number; cursor: string }> = [
  { handle: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { handle: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { handle: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { handle: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { handle: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { handle: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { handle: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { handle: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
]

const HANDLE_HIT = 10

const TOOL_ICON: Record<ShotTool, typeof Square> = {
  select: MousePointer2,
  rectangle: Square,
  ellipse: Circle,
  arrow: ArrowUpRight,
  pen: Pencil,
  text: Type,
  mosaic: ScanLine,
}

type Drag =
  | { kind: 'select'; start: Point }
  | { kind: 'move'; start: Point; before: Rect }
  | { kind: 'resize'; start: Point; before: Rect; handle: Handle }
  | { kind: 'draw'; annotation: Annotation }

/** 选区命中测试：先看 8 个手柄，再看是否落在框内 */
function handleAt(point: Point, rect: Rect): Handle | null {
  for (const item of HANDLES) {
    const x = rect.x + rect.width * item.x
    const y = rect.y + rect.height * item.y
    if (Math.abs(point.x - x) <= HANDLE_HIT && Math.abs(point.y - y) <= HANDLE_HIT) return item.handle
  }
  return null
}

function resizeRect(rect: Rect, handle: Handle, point: Point): Rect {
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.width
  let bottom = rect.y + rect.height
  if (handle.includes('w')) left = point.x
  if (handle.includes('e')) right = point.x
  if (handle.includes('n')) top = point.y
  if (handle.includes('s')) bottom = point.y
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
  }
}

export function ScreenshotOverlay() {
  const t = useT()
  const shot = useScreenshotStore((state) => state.shot)
  const close = useScreenshotStore((state) => state.close)

  const [image, setImage] = useState<HTMLImageElement | null>(null)
  /**
   * 显示用的位图：已经按「画布后备像素」缩小好，画布只做 1:1 贴图
   *
   * 早先是把 1001×425 的原图交给 `drawImage` 直接压到几百像素宽。宿主是
   * WebView2，这种大比例缩小走的是 GPU 缩放路径，密集小字的截图会被采成
   * 阶梯状斜条纹（用户反馈的「花屏」）。改成先在解码阶段按目标像素缩放
   * （`createImageBitmap` 的 resizeQuality=high），画布 1:1 贴上去，
   * 既不糊也不会错位。
   */
  const [sample, setSample] = useState<ImageBitmap | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [selection, setSelection] = useState<Rect | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [redo, setRedo] = useState<Annotation[]>([])
  const [tool, setTool] = useState<ShotTool>('select')
  const [color, setColor] = useState(SHOT_COLORS[0])
  const [strokeWidth, setStrokeWidth] = useState(SHOT_WIDTHS[1])
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<Drag | null>(null)
  /** 已经为哪一张图铺过默认选区，避免窗口缩放时反复把用户的调整冲掉 */
  const preselectedRef = useRef<string | null>(null)

  // 换一张截图就重置整份编辑状态
  useEffect(() => {
    setSelection(null)
    setAnnotations([])
    setRedo([])
    setTool('select')
    setDraft(null)
    setTextDraft(null)
    setBusy(false)
    setImage(null)
    preselectedRef.current = null
    if (!shot) return
    const next = new Image()
    next.onload = () => setImage(next)
    next.src = shot.dataUrl
  }, [shot])

  // 整屏图按窗口等比缩放，四周留白给工具条
  useEffect(() => {
    if (!image) return
    const compute = () => {
      const scale = Math.min(
        (window.innerWidth - 48) / image.naturalWidth,
        (window.innerHeight - 150) / image.naturalHeight,
        1,
      )
      setViewport({
        width: Math.max(1, Math.round(image.naturalWidth * scale)),
        height: Math.max(1, Math.round(image.naturalHeight * scale)),
      })
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [image])

  // 桌面已经框好的区域：进来就把选区铺满整张图，用户可以直接标注或改框
  useEffect(() => {
    if (!shot?.preselected || !image || viewport.width < 2) return
    if (preselectedRef.current === shot.dataUrl) return
    preselectedRef.current = shot.dataUrl
    setSelection({ x: 0, y: 0, width: viewport.width, height: viewport.height })
  }, [image, shot, viewport.height, viewport.width])

  // 按「画布后备像素」重新解码一张缩好的位图，供画布 1:1 贴图
  useEffect(() => {
    const url = shot?.dataUrl
    if (!image || !url || viewport.width < 2 || typeof createImageBitmap !== 'function') {
      setSample(null)
      return
    }
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(viewport.width * dpr))
    const height = Math.max(1, Math.round(viewport.height * dpr))
    let cancelled = false
    const build = async () => {
      try {
        const blob = await (await fetch(url)).blob()
        const bitmap = await createImageBitmap(blob, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'high',
        })
        if (cancelled) {
          bitmap.close()
          return
        }
        setSample((previous) => {
          previous?.close()
          return bitmap
        })
        // 记一行几何信息：万一不同宿主上还有渲染差异，日志里能直接对上尺寸
        void rpc
          .logWrite(
            `浮层就绪：视口 ${viewport.width}×${viewport.height} · 后备 ${width}×${height} · dpr=${dpr} · 原图 ${image.naturalWidth}×${image.naturalHeight}`,
          )
          .catch(() => {})
      } catch {
        // 解码失败就退回原图直接画（老路径，能用但质量差一点）
        if (!cancelled) setSample(null)
      }
    }
    void build()
    return () => {
      cancelled = true
    }
  }, [image, shot?.dataUrl, viewport.height, viewport.width])

  const toLocal = useCallback(
    (event: React.PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return clampPoint(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        viewport.width,
        viewport.height,
      )
    },
    [viewport.height, viewport.width],
  )

  // 重绘：合成层（图片 + 已提交标注）+ 压暗 + 草稿 + 选框
  //
  // 为什么要合成层：原来每帧都把全部标注重画一遍，马赛克里还要「画布自读回」采样，
  // 拖动 / 调粗细时一帧就是几十毫秒，手感明显发滞。现在已提交的标注只烘焙一次，
  // 拖动时每帧只贴一张图 + 画草稿。
  const stageRef = useRef<HTMLCanvasElement | null>(null)
  const stageKeyRef = useRef<{
    annotations: readonly Annotation[]
    source: unknown
    width: number
    height: number
    dpr: number
  } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || viewport.width < 2) return
    const dpr = window.devicePixelRatio || 1
    // 后备像素与 CSS 尺寸成整数倍：不留半像素误差，缩放时不会被拉斜。
    // 只在尺寸真的变了才赋值——给 canvas.width 赋同值也会重建后备存储（整块清零）。
    const width = Math.max(1, Math.round(viewport.width * dpr))
    const height = Math.max(1, Math.round(viewport.height * dpr))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'

    const source = sample ?? image
    if (!stageRef.current) stageRef.current = document.createElement('canvas')
    const key = stageKeyRef.current
    if (
      !key ||
      key.annotations !== annotations ||
      key.source !== source ||
      key.width !== viewport.width ||
      key.height !== viewport.height ||
      key.dpr !== dpr
    ) {
      composeStage(stageRef.current, source, viewport, annotations, dpr)
      stageKeyRef.current = {
        annotations,
        source,
        width: viewport.width,
        height: viewport.height,
        dpr,
      }
    }

    // sample 已经是目标像素尺寸，按 CSS 尺寸贴上去正好 1:1（不会二次重采样）
    paintScene(context, source, viewport, annotations, {
      dim: true,
      selection,
      draft,
      stage: stageRef.current,
    })

    if (selection) {
      context.save()
      context.strokeStyle = 'rgba(255,255,255,0.95)'
      context.lineWidth = 1.5
      context.setLineDash([6, 4])
      context.strokeRect(selection.x, selection.y, selection.width, selection.height)
      context.setLineDash([])
      if (tool === 'select') {
        context.fillStyle = '#ffffff'
        context.strokeStyle = 'rgba(0,0,0,0.35)'
        for (const item of HANDLES) {
          const x = selection.x + selection.width * item.x
          const y = selection.y + selection.height * item.y
          context.beginPath()
          context.rect(x - 4, y - 4, 8, 8)
          context.fill()
          context.stroke()
        }
      }
      context.restore()
    }
  }, [annotations, draft, image, sample, selection, tool, viewport])

  const commitAnnotation = useCallback((annotation: Annotation) => {
    const start = annotation.points[0]
    const end = annotation.points[annotation.points.length - 1]
    const tiny = Math.abs(end.x - start.x) < 3 && Math.abs(end.y - start.y) < 3
    if (annotation.tool !== 'pen' && annotation.tool !== 'text' && tiny) return
    setAnnotations((current) => [...current, annotation])
    setRedo([])
  }, [])

  const undo = useCallback(() => {
    setAnnotations((current) => {
      if (current.length === 0) return current
      const last = current[current.length - 1]
      setRedo((stack) => [...stack, last])
      return current.slice(0, -1)
    })
  }, [])

  const redoLast = useCallback(() => {
    setRedo((stack) => {
      if (stack.length === 0) return stack
      const last = stack[stack.length - 1]
      setAnnotations((current) => [...current, last])
      return stack.slice(0, -1)
    })
  }, [])

  const onPointerDown = (event: React.PointerEvent) => {
    if (!image) return
    event.preventDefault()
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
    const point = toLocal(event)

    if (tool === 'select') {
      if (selection) {
        const handle = handleAt(point, selection)
        if (handle) {
          dragRef.current = { kind: 'resize', start: point, before: selection, handle }
          return
        }
        if (pointInRect(point, selection)) {
          dragRef.current = { kind: 'move', start: point, before: selection }
          return
        }
      }
      dragRef.current = { kind: 'select', start: point }
      setSelection({ x: point.x, y: point.y, width: 0, height: 0 })
      return
    }

    if (tool === 'text') {
      setTextDraft({ x: point.x, y: point.y, value: '' })
      return
    }

    const annotation: Annotation = {
      id: localId(),
      tool,
      points: [point, point],
      color,
      width: strokeWidth,
    }
    dragRef.current = { kind: 'draw', annotation }
    setDraft(annotation)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const point = toLocal(event)

    if (drag.kind === 'select') {
      setSelection(rectFromPoints(drag.start, point))
      return
    }
    if (drag.kind === 'move') {
      const dx = point.x - drag.start.x
      const dy = point.y - drag.start.y
      const x = Math.max(0, Math.min(viewport.width - drag.before.width, drag.before.x + dx))
      const y = Math.max(0, Math.min(viewport.height - drag.before.height, drag.before.y + dy))
      setSelection({ ...drag.before, x, y })
      return
    }
    if (drag.kind === 'resize') {
      setSelection(resizeRect(drag.before, drag.handle, point))
      return
    }
    if (drag.kind === 'draw') {
      const next: Annotation =
        drag.annotation.tool === 'pen'
          ? { ...drag.annotation, points: [...drag.annotation.points, point] }
          : { ...drag.annotation, points: [drag.annotation.points[0], point] }
      dragRef.current = { kind: 'draw', annotation: next }
      setDraft(next)
    }
  }

  const onPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.kind === 'draw') {
      setDraft(null)
      commitAnnotation(drag.annotation)
    }
  }

  const commitText = () => {
    if (!textDraft) return
    const value = textDraft.value.trim()
    setTextDraft(null)
    if (!value) return
    commitAnnotation({
      id: localId(),
      tool: 'text',
      points: [{ x: textDraft.x, y: textDraft.y }],
      color,
      width: strokeWidth,
      text: value,
    })
  }

  /** 选区内裁剪 + 合成标注 → PNG */
  const render = async () => {
    if (!image) throw new Error(t('shot.notReady'))
    return cropSelection(image, viewport, selection, annotations)
  }

  const withBusy = async (task: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await task()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const copy = () =>
    withBusy(async () => {
      const out = await render()
      // 优先让 Sidecar 写系统剪贴板（宿主 iframe 里 Clipboard API 常被拒）
      try {
        await rpc.clipboardWrite({ dataBase64: out.dataBase64, mime: out.mime })
      } catch {
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
          throw new Error(t('shot.copyDenied'))
        }
        const blob = await (await fetch(`data:image/png;base64,${out.dataBase64}`)).blob()
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      }
      toast.success(t('shot.copied', { width: out.width, height: out.height }))
      close()
    })

  const saveRecord = () =>
    withBusy(async () => {
      const out = await render()
      // 落库后异步请识别模型看图，结果补进 meta.text（记录里会显示在缩略图下面）
      await saveShotToRecords(out.dataBase64, out.mime)
      toast.success(t('shot.savedRecord'))
      close()
    })

  const insert = () =>
    withBusy(async () => {
      const out = await render()
      const ok = await insertCapturedImage(out.dataBase64, out.mime)
      if (!ok) throw new Error(t('editor.noFile'))
      toast.success(t('shot.inserted'))
      close()
    })

  // 钉在顶层：浮层在 iframe 里开不了桌面窗口，把图交回 Sidecar 贴一个置顶小窗
  const pin = () =>
    withBusy(async () => {
      const out = await render()
      await rpc.screenshotPin({ dataBase64: out.dataBase64 })
      toast.success(t('shot.pinned'))
      close()
    })

  const download = () =>
    withBusy(async () => {
      const out = await render()
      const link = document.createElement('a')
      link.href = `data:${out.mime};base64,${out.dataBase64}`
      link.download = stampName(out.mime)
      link.click()
      toast.success(t('shot.downloaded'))
    })

  // 键盘：Esc 关、Enter 保存到记录、Ctrl+Z / Ctrl+Shift+Z 撤销重做、字母切工具
  useEffect(() => {
    if (!shot) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (textDraft) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        void saveRecord()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoLast()
        else undo()
        return
      }
      const matched = SHOT_TOOLS.find((item) => item.shortcut.toLowerCase() === event.key.toLowerCase())
      if (matched && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setTool(matched.tool)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // saveRecord / undo / redoLast 都只依赖当前状态，这里跟着 shot 重建即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot, textDraft, undo, redoLast])

  // 工具条常驻图片正下方：以前用 fixed + 视口坐标算位置，宿主的 WebView2 里
  // 一旦层级/合成出偏，工具条就会整条不见（用户两次反馈「没有下方的工具栏」）。
  // 现在它只是普通流里的一个 flex 子项，位置由布局决定，任何窗口尺寸都跑不掉。

  if (!shot) return null

  const sizeLabel = selection && selection.width > 1
    ? `${Math.round(selection.width)} × ${Math.round(selection.height)} px`
    : `${shot.width} × ${shot.height} px`

  return (
    <div
      data-screenshot-overlay
      role="dialog"
      aria-modal="true"
      aria-label={t('shot.title')}
      className="fixed inset-0 z-[100] flex select-none flex-col items-center justify-center gap-3 overflow-hidden bg-neutral-950/95 p-6"
    >
      <div className="relative" style={{ width: viewport.width, height: viewport.height }}>
        <canvas
          ref={canvasRef}
          data-screenshot-canvas
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          style={{ width: viewport.width, height: viewport.height }}
          className={cn(
            'block rounded-md shadow-2xl',
            tool === 'select' ? 'cursor-crosshair' : 'cursor-crosshair',
          )}
        />

        {/* 选区尺寸：贴在选框上方 */}
        {selection && selection.width > 1 ? (
          <div
            data-screenshot-size
            className="pointer-events-none absolute -top-6 left-0 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white tabular-nums"
            style={{ left: Math.min(selection.x, Math.max(0, viewport.width - 120)) }}
          >
            {sizeLabel}
          </div>
        ) : null}

        {/* 文字标注的输入面板（对齐参考项目：多行 + 取消文字 / 添加文字） */}
        {textDraft ? (
          <div
            data-shot-text-panel
            className="absolute z-20 flex flex-col gap-2 rounded-lg border border-border/60 bg-popover p-2 text-popover-foreground shadow-xl"
            style={{
              left: Math.min(Math.max(8, textDraft.x), Math.max(8, viewport.width - 296)),
              top: Math.min(Math.max(8, textDraft.y), Math.max(8, viewport.height - 180)),
              width: Math.min(288, Math.max(180, viewport.width - 16)),
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <textarea
              autoFocus
              value={textDraft.value}
              onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                // 回车提交，Shift + 回车换行（与参考项目一致）
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  commitText()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setTextDraft(null)
                }
              }}
              rows={3}
              placeholder={t('shot.textPlaceholder')}
              aria-label={t('shot.tool.text')}
              className="max-h-48 min-h-16 w-full resize-none rounded border border-border/60 bg-transparent px-1.5 py-1 text-sm outline-none"
              style={{ color, fontSize: Math.max(14, strokeWidth * 6) }}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setTextDraft(null)}>
                {t('shot.discardText')}
              </Button>
              <Button type="button" size="sm" onClick={commitText}>
                {t('shot.addText')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 工具条：跟着图片走，永远在它正下方；窄面板换行而不是横向滚出可视区 */}
      <div
        data-screenshot-toolbar
        className="z-[110] flex shrink-0 flex-wrap items-center justify-center gap-0.5 rounded-lg border border-border/60 bg-popover p-1 text-popover-foreground shadow-xl"
        style={{ maxWidth: '100%' }}
      >
          {SHOT_TOOLS.map((item) => {
            const Icon = TOOL_ICON[item.tool]
            return (
              <Hint key={item.tool} label={`${t(item.key)} · ${item.shortcut}`}>
                <button
                  type="button"
                  data-shot-tool={item.tool}
                  aria-label={t(item.key)}
                  aria-pressed={tool === item.tool}
                  onClick={() => setTool(item.tool)}
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded transition-colors',
                    tool === item.tool
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              </Hint>
            )
          })}

          <span className="mx-1 h-5 w-px shrink-0 bg-border" />

          {/* 颜色与粗细：只对绘制工具有意义 */}
          {tool !== 'select' ? (
            <>
              <div className="flex shrink-0 items-center gap-0.5" data-shot-colors>
                {SHOT_COLORS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    data-shot-color={item}
                    aria-label={item}
                    aria-pressed={color === item}
                    onClick={() => setColor(item)}
                    className={cn(
                      'size-4 shrink-0 rounded-full border transition-transform',
                      color === item ? 'scale-110 border-primary ring-1 ring-primary/40' : 'border-border',
                    )}
                    style={{ backgroundColor: item }}
                  />
                ))}
              </div>
              <span className="mx-0.5 h-5 w-px shrink-0 bg-border" />
              <div className="flex shrink-0 items-center gap-0.5" data-shot-widths>
                {SHOT_WIDTHS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    data-shot-width={item}
                    aria-label={`${item}px`}
                    aria-pressed={strokeWidth === item}
                    onClick={() => setStrokeWidth(item)}
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded transition-colors',
                      strokeWidth === item ? 'bg-primary/15' : 'hover:bg-muted',
                    )}
                  >
                    <span
                      className="rounded-full bg-foreground"
                      style={{ width: Math.min(12, item + 3), height: Math.min(12, item + 3), opacity: 0.8 }}
                    />
                  </button>
                ))}
              </div>
              <span className="mx-1 h-5 w-px shrink-0 bg-border" />
            </>
          ) : null}

          <button
            type="button"
            data-shot-undo
            aria-label={t('shot.undo')}
            disabled={annotations.length === 0}
            onClick={undo}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Undo2 className="size-3.5" />
          </button>
          <button
            type="button"
            data-shot-redo
            aria-label={t('shot.redo')}
            disabled={redo.length === 0}
            onClick={redoLast}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Redo2 className="size-3.5" />
          </button>

          <span className="mx-1 h-5 w-px shrink-0 bg-border" />

          <Hint label={t('shot.copy')}>
            <button
              type="button"
              data-shot-copy
              aria-label={t('shot.copy')}
              onClick={() => void copy()}
              className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Copy className="size-3.5" />
            </button>
          </Hint>
          <Hint label={t('shot.pin')}>
            <button
              type="button"
              data-shot-pin
              aria-label={t('shot.pin')}
              onClick={() => void pin()}
              className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Pin className="size-3.5" />
            </button>
          </Hint>
          <Hint label={t('shot.download')}>
            <button
              type="button"
              data-shot-download
              aria-label={t('shot.download')}
              onClick={() => void download()}
              className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="size-3.5" />
            </button>
          </Hint>
          <Hint label={t('shot.insert')}>
            <button
              type="button"
              data-shot-insert
              aria-label={t('shot.insert')}
              onClick={() => void insert()}
              className="ml-0.5 flex h-7 shrink-0 items-center gap-1 rounded border border-border px-2 text-xs text-foreground transition-colors hover:bg-muted"
            >
              {t('shot.insert')}
            </button>
          </Hint>
          <Button
            size="xs"
            data-shot-save
            className="ml-0.5 shrink-0"
            disabled={busy}
            onClick={() => void saveRecord()}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            {t('shot.saveRecord')}
          </Button>
          <button
            type="button"
            data-shot-close
            aria-label={t('common.close')}
            onClick={close}
            className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>

      <p className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/80">
        {t('shot.hint')}
      </p>
    </div>
  )
}
