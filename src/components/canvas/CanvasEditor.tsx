import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ChartNoAxesCombined,
  Eraser,
  Frame,
  Hand,
  Highlighter,
  ImagePlus,
  LayoutGrid,
  Link2,
  Loader2,
  Maximize2,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Save,
  Shapes,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { defaultChartSpec, type CanvasChartSpec } from '@/lib/canvasChart'
import { shapeDefaultSize, type CanvasShapeType } from '@/lib/canvasShapes'
import { persistImage } from '@/lib/imageStore'
import * as rpc from '@/lib/rpc'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'
import {
  flushCanvasSave,
  nodeSize,
  useCanvasStore,
  type CanvasNode,
} from '@/stores/canvas'
import { CanvasChartArt } from './CanvasChartArt'
import { CanvasShapeArt } from './CanvasShapeArt'
import { ChartPanel } from './ChartPanel'
import { ShapeLibrary } from './ShapeLibrary'

/** 卡片缺省尺寸（连线端点按节点实际尺寸算，见 nodeSize） */
const NODE_W = 208
const NODE_H = 76
const MIN_SCALE = 0.4
const MAX_SCALE = 1.8

interface View {
  scale: number
  tx: number
  ty: number
}

/** 画布工具（左侧竖排工具条，与参考实现的工具栏一一对应） */
type CanvasTool = 'select' | 'pan' | 'pen' | 'highlighter' | 'eraser'

const TOOLS: Array<{
  value: CanvasTool
  icon: typeof MousePointer2
  labelKey: string
  /** 单键快捷键（不在输入框里时生效） */
  key: string
}> = [
  { value: 'select', icon: MousePointer2, labelKey: 'canvas.tool.select', key: 'v' },
  { value: 'pan', icon: Hand, labelKey: 'canvas.tool.pan', key: 'h' },
  { value: 'pen', icon: Pencil, labelKey: 'canvas.tool.pen', key: 'p' },
  { value: 'highlighter', icon: Highlighter, labelKey: 'canvas.tool.highlighter', key: 'm' },
  { value: 'eraser', icon: Eraser, labelKey: 'canvas.tool.eraser', key: 'e' },
]

/** 手绘笔迹的平滑：中点二次贝塞尔，比直线连点顺眼且不用引第三方库 */
function strokePath(points: [number, number][]): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    const [x, y] = points[0]
    return `M ${x} ${y} L ${x + 0.6} ${y}`
  }
  let path = `M ${points[0][0]} ${points[0][1]}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index]
    const [x2, y2] = points[index + 1]
    path += ` Q ${x1} ${y1} ${(x1 + x2) / 2} ${(y1 + y2) / 2}`
  }
  const last = points[points.length - 1]
  path += ` L ${last[0]} ${last[1]}`
  return path
}


/**
 * 画布编辑器：白板式节点 + 连线
 *
 * - 双击空白新增卡片，拖动卡片移动，右侧圆点连到另一张卡片
 * - 滚轮缩放、空白拖拽平移、`Delete` 删除选中卡片
 * - 每次改动 600ms 防抖写盘，切换画布或关闭前强制落盘
 */
export function CanvasEditor() {
  const t = useT()
  const activePath = useCanvasStore((state) => state.activePath)
  const doc = useCanvasStore((state) => state.doc)
  const dirty = useCanvasStore((state) => state.dirty)
  const saveState = useCanvasStore((state) => state.saveState)
  const addNode = useCanvasStore((state) => state.addNode)
  const updateNode = useCanvasStore((state) => state.updateNode)
  const removeNode = useCanvasStore((state) => state.removeNode)
  const addEdge = useCanvasStore((state) => state.addEdge)
  const removeEdge = useCanvasStore((state) => state.removeEdge)
  const setTitle = useCanvasStore((state) => state.setTitle)
  const tidy = useCanvasStore((state) => state.tidy)
  const close = useCanvasStore((state) => state.close)
  const save = useCanvasStore((state) => state.save)
  /** 网格 / 吸附 / 缩放 / 滚轮行为都取自「设置 → 画布设置」 */
  const canvasSettings = useSettingsStore((state) => state.canvas)

  const boardRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 })
  /** 画布可视区尺寸，用于小地图的视口框与右键平移范围 */
  const [board, setBoard] = useState({ w: 0, h: 0 })
  const [selected, setSelected] = useState('')
  const [editing, setEditing] = useState('')
  const [tool, setTool] = useState<CanvasTool>('select')
  const [linkFrom, setLinkFrom] = useState('')
  const [shapePanel, setShapePanel] = useState(false)
  /** 正在编辑数据的图表节点 */
  const [chartTarget, setChartTarget] = useState('')
  /** 手绘临时笔迹（画布坐标） */
  const [strokeDraft, setStrokeDraft] = useState<[number, number][]>([])
  /** 图片节点的 dataUrl 缓存（沙箱里不能直接 <img src="相对路径">） */
  const [imageCache, setImageCache] = useState<Record<string, string>>({})
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const panRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null)
  const drawRef = useRef<{ mode: 'pen' | 'highlighter'; points: [number, number][] } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const resizeRef = useRef<{ id: string; startX: number; startY: number; w: number; h: number } | null>(
    null,
  )

  /** 屏幕坐标 → 画布坐标 */
  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = boardRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return {
        x: (clientX - rect.left - view.tx) / view.scale,
        y: (clientY - rect.top - view.ty) / view.scale,
      }
    },
    [view],
  )

  // 记录画布可视区尺寸：小地图的视口框与「适应画布」都依赖它
  useEffect(() => {
    const element = boardRef.current
    if (!element) return
    const sync = () => setBoard({ w: element.clientWidth, h: element.clientHeight })
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    return () => observer.disconnect()
  }, [activePath])

  // 画布快捷键：Delete 删选中，Esc 回选择工具，V/H/P/M/E 切工具
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (editing) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selected) return
        event.preventDefault()
        removeNode(selected)
        setSelected('')
        return
      }
      if (event.key === 'Escape') {
        setLinkFrom('')
        setShapePanel(false)
        setChartTarget('')
        setTool('select')
        return
      }
      const next = TOOLS.find((item) => item.key === event.key.toLowerCase())
      if (next) {
        event.preventDefault()
        setTool(next.value)
        setLinkFrom('')
        setShapePanel(false)
        setChartTarget('')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editing, removeNode, selected])

  // 画布节点被替换（切换画布）时清空临时交互态，并按设置回到默认缩放
  useEffect(() => {
    setSelected('')
    setEditing('')
    setLinkFrom('')
    setShapePanel(false)
    setChartTarget('')
    setStrokeDraft([])
    const zoom = Math.min(MAX_SCALE, Math.max(MIN_SCALE, useSettingsStore.getState().canvas.defaultZoom / 100))
    setView({ scale: zoom, tx: 0, ty: 0 })
  }, [activePath])


  const nodes = doc?.nodes ?? []
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])

  /** 网格：跟着「设置 → 画布」的样式与间距走 */
  const gridGap = canvasSettings.gridGap > 0 ? canvasSettings.gridGap : 24
  const gridBackground = !canvasSettings.showGrid || canvasSettings.gridStyle === 'none'
    ? undefined
    : canvasSettings.gridStyle === 'dots'
      ? 'radial-gradient(circle at 1px 1px, hsl(var(--muted-foreground) / 0.18) 1px, transparent 0)'
      : 'linear-gradient(to right, hsl(var(--muted-foreground) / 0.12) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--muted-foreground) / 0.12) 1px, transparent 1px)'

  /**
   * 小地图：缩放到 96×96 的方框里，并画出当前视口框
   *
   * 与参考实现的画布缩略图一致：内容范围与视口范围取并集，
   * 这样平移 / 缩放时能看清自己在整张图的哪个位置。
   */
  const minimap = useMemo(() => {
    const viewLeft = -view.tx / view.scale
    const viewTop = -view.ty / view.scale
    const viewW = board.w / view.scale
    const viewH = board.h / view.scale
    const hasContent = nodes.length > 0
    const minX = hasContent ? Math.min(...nodes.map((node) => node.x)) : viewLeft
    const minY = hasContent ? Math.min(...nodes.map((node) => node.y)) : viewTop
    const maxX = hasContent
      ? Math.max(...nodes.map((node) => node.x + nodeSize(node).w))
      : viewLeft + viewW
    const maxY = hasContent
      ? Math.max(...nodes.map((node) => node.y + nodeSize(node).h))
      : viewTop + viewH

    const left = board.w > 0 ? Math.min(minX, viewLeft) : minX
    const top = board.h > 0 ? Math.min(minY, viewTop) : minY
    const right = board.w > 0 ? Math.max(maxX, viewLeft + viewW) : maxX
    const bottom = board.h > 0 ? Math.max(maxY, viewTop + viewH) : maxY
    const spanX = Math.max(1, right - left)
    const spanY = Math.max(1, bottom - top)
    const place = (x: number, y: number, w: number, h: number) => ({
      left: ((x - left) / spanX) * 100,
      top: ((y - top) / spanY) * 100,
      width: (w / spanX) * 100,
      height: (h / spanY) * 100,
    })
    return {
      span: { left, top, spanX, spanY },
      boxes: nodes.map((node) => {
        const { w, h } = nodeSize(node)
        return { id: node.id, ...place(node.x, node.y, w, h) }
      }),
      viewport: board.w > 0 ? place(viewLeft, viewTop, viewW, viewH) : null,
    }
  }, [board.h, board.w, nodes, view.scale, view.tx, view.ty])

  const handleNodePointerDown = (event: React.PointerEvent, node: CanvasNode) => {
    if (editing === node.id) return
    event.stopPropagation()
    // 橡皮：点一下就删
    if (tool === 'eraser') {
      removeNode(node.id)
      if (selected === node.id) setSelected('')
      return
    }
    // 连线态（点了卡片上的连接圆点）：这一下决定连线的另一端
    if (linkFrom) {
      if (linkFrom === node.id) {
        setLinkFrom('')
        return
      }
      addEdge(linkFrom, node.id)
      setLinkFrom('')
      return
    }
    setSelected(node.id)
    const world = toWorld(event.clientX, event.clientY)
    dragRef.current = { id: node.id, offsetX: world.x - node.x, offsetY: world.y - node.y }
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent) => {
    if (resizeRef.current) {
      const current = resizeRef.current
      const dx = (event.clientX - current.startX) / view.scale
      const dy = (event.clientY - current.startY) / view.scale
      updateNode(current.id, {
        w: Math.max(48, Math.round(current.w + dx)),
        h: Math.max(32, Math.round(current.h + dy)),
      })
      return
    }
    if (drawRef.current) {
      const world = toWorld(event.clientX, event.clientY)
      drawRef.current.points.push([world.x, world.y])
      setStrokeDraft([...drawRef.current.points])
      return
    }
    if (dragRef.current) {
      const world = toWorld(event.clientX, event.clientY)
      let x = world.x - dragRef.current.offsetX
      let y = world.y - dragRef.current.offsetY
      if (canvasSettings.snapToGrid && canvasSettings.gridGap > 0) {
        const gap = canvasSettings.gridGap
        x = Math.round(x / gap) * gap
        y = Math.round(y / gap) * gap
      }
      updateNode(dragRef.current.id, { x: Math.round(x), y: Math.round(y) })
      return
    }
    if (panRef.current) {
      setView((current) => ({
        ...current,
        tx: panRef.current!.tx + (event.clientX - panRef.current!.startX),
        ty: panRef.current!.ty + (event.clientY - panRef.current!.startY),
      }))
    }
  }

  /** 结束一笔手绘：把点序列收成一个自由笔迹节点 */
  const finishStroke = () => {
    const draft = drawRef.current
    drawRef.current = null
    setStrokeDraft([])
    if (!draft || draft.points.length === 0) return
    const xs = draft.points.map((point) => point[0])
    const ys = draft.points.map((point) => point[1])
    const padding = 8
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const w = Math.max(8, Math.max(...xs) - minX) + padding * 2
    const h = Math.max(8, Math.max(...ys) - minY) + padding * 2
    const points = draft.points.map(([x, y]) => [x - minX + padding, y - minY + padding] as [number, number])
    addNode(minX - padding, minY - padding, '', {
      kind: 'freehand',
      w,
      h,
      stroke: {
        points,
        mode: draft.mode,
        width: draft.mode === 'pen' ? 2.2 : 16,
        color: draft.mode === 'pen' ? 'hsl(var(--foreground))' : 'rgb(250 204 21 / 0.45)',
      },
    })
  }

  const handlePointerUp = () => {
    if (drawRef.current) finishStroke()
    dragRef.current = null
    panRef.current = null
    resizeRef.current = null
  }

  const handleWheel = (event: React.WheelEvent) => {
    event.preventDefault()
    const rect = boardRef.current?.getBoundingClientRect()
    if (!rect) return

    // 滚轮行为：平移画布
    if (canvasSettings.wheel === 'pan') {
      setView((current) => ({
        ...current,
        tx: current.tx - event.deltaX,
        ty: current.ty - event.deltaY,
      }))
      return
    }

    const nextScale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, view.scale - event.deltaY * 0.0015),
    )
    // 以光标为锚点缩放
    const pointX = event.clientX - rect.left
    const pointY = event.clientY - rect.top
    setView({
      scale: nextScale,
      tx: pointX - ((pointX - view.tx) / view.scale) * nextScale,
      ty: pointY - ((pointY - view.ty) / view.scale) * nextScale,
    })
  }

  /** 适应画布：把所有节点缩放居中到可视区（参考实现的 fit 行为） */
  const fitToContent = () => {
    if (nodes.length === 0 || board.w === 0 || board.h === 0) {
      setView({ scale: 1, tx: 0, ty: 0 })
      return
    }
    const minX = Math.min(...nodes.map((node) => node.x))
    const minY = Math.min(...nodes.map((node) => node.y))
    const maxX = Math.max(...nodes.map((node) => node.x + nodeSize(node).w))
    const maxY = Math.max(...nodes.map((node) => node.y + nodeSize(node).h))
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((board.w - 80) / (maxX - minX || 1), (board.h - 80) / (maxY - minY || 1))),
    )
    setView({
      scale,
      tx: board.w / 2 - ((minX + maxX) / 2) * scale,
      ty: board.h / 2 - ((minY + maxY) / 2) * scale,
    })
  }

  /**
   * 在可视区中心落一个节点，返回 id
   *
   * 与已有节点重叠时按「下 → 右 → 右下」的环形顺序就近让位，位移控制在两格以内：
   * 早先的写法是一直往下推到不重叠（最多 40 格），插入图表 / 图片后节点会被甩到
   * 视野外几千像素，用户看到的就是「点了没反应」。
   */
  const insertAtCenter = (size: { w: number; h: number }, extras: Partial<CanvasNode>) => {
    const baseX = (board.w / 2 - view.tx) / view.scale - size.w / 2
    const baseY = (board.h / 2 - view.ty) / view.scale - size.h / 2
    const collides = (x: number, y: number) =>
      nodes.some((node) => {
        const other = nodeSize(node)
        return !(
          x + size.w + 24 < node.x ||
          node.x + other.w + 24 < x ||
          y + size.h + 24 < node.y ||
          node.y + other.h + 24 < y
        )
      })
    const stepX = size.w + 32
    const stepY = size.h + 32
    let startX = baseX
    let startY = baseY
    for (const [dx, dy] of [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [-1, 0],
      [0, -1],
      [-1, 1],
    ] as const) {
      const x = baseX + dx * stepX
      const y = baseY + dy * stepY
      if (!collides(x, y)) {
        startX = x
        startY = y
        break
      }
    }
    // 让位后可能落到视口外（放大画布时一格就出界）：把视图平移过去，
    // 而不是硬塞回可视区——硬塞会压在已有卡片上，点都点不到。
    const viewLeft = -view.tx / view.scale
    const viewTop = -view.ty / view.scale
    const viewW = board.w / view.scale
    const viewH = board.h / view.scale
    const pad = 24 / view.scale
    let dx = 0
    let dy = 0
    if (startX < viewLeft + pad) dx = viewLeft + pad - startX
    else if (startX + size.w > viewLeft + viewW - pad) {
      dx = viewLeft + viewW - pad - (startX + size.w)
    }
    if (startY < viewTop + pad) dy = viewTop + pad - startY
    else if (startY + size.h > viewTop + viewH - pad) {
      dy = viewTop + viewH - pad - (startY + size.h)
    }
    const id = addNode(startX, startY, '', { ...extras, ...size })
    setSelected(id)
    // 节点在当前缩放下装不进视口（比如 520×340 的图表在 180% 下比画布还大）：
    // 先把缩放调小再居中，保证「插入后立刻看得见」；装得下就只做平移。
    if (size.w * view.scale > board.w - 64 || size.h * view.scale > board.h - 64) {
      const scale = Math.max(
        MIN_SCALE,
        Math.min(view.scale, (board.w - 96) / size.w, (board.h - 96) / size.h),
      )
      setView({
        scale,
        tx: board.w / 2 - (startX + size.w / 2) * scale,
        ty: board.h / 2 - (startY + size.h / 2) * scale,
      })
    } else if (dx !== 0 || dy !== 0) {
      // 世界坐标的窗口偏移换算回屏幕平移：窗口 left/top = -tx/scale，
      // 窗口要移 dx/dy，等价于 tx/ty 加上 dx*scale / dy*scale
      setView((current) => ({
        ...current,
        tx: current.tx + dx * current.scale,
        ty: current.ty + dy * current.scale,
      }))
    }
    return id
  }

  /** 从图形库插入一个图形（`at` 为空时落中心） */
  const insertShape = (type: CanvasShapeType, at?: { x: number; y: number }) => {
    const size = shapeDefaultSize(type)
    const extras: Partial<CanvasNode> = { kind: 'shape', shape: type }
    const id = at
      ? addNode(at.x - size.w / 2, at.y - size.h / 2, '', { ...extras, ...size })
      : insertAtCenter(size, extras)
    setSelected(id)
    setShapePanel(false)
    setTool('select')
    setEditing(type === 'text' ? id : '')
    return id
  }

  /** 插入一张数据图表，并直接打开编辑面板 */
  const insertChart = () => {
    // 420×300：分栏布局下画布只有 ~520px 宽，再大就会顶满整屏、编辑面板也没地方放
    const id = insertAtCenter({ w: 420, h: 300 }, { kind: 'chart', chart: defaultChartSpec() })
    setChartTarget(id)
    setShapePanel(false)
    setTool('select')
    return id
  }

  /** 选本地图片 → 落到图片目录（或图床）→ 一个图片节点 */
  const insertImageFile = async (file: File) => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        resolve(result.slice(result.indexOf(',') + 1))
      }
      reader.onerror = () => reject(new Error('读取图片失败'))
      reader.readAsDataURL(file)
    })
    const saved = await persistImage({
      name: file.name,
      dataBase64: base64,
      mime: file.type || 'image/png',
    })
    setImageCache((current) => ({
      ...current,
      [saved.src]: `data:${file.type || 'image/png'};base64,${base64}`,
    }))
    insertAtCenter({ w: 260, h: 180 }, { kind: 'image', image: { src: saved.src, name: file.name } })
    setShapePanel(false)
    setTool('select')
  }

  // 图片节点：把工作区里的相对路径读成 dataUrl（沙箱里 <img src="相对路径"> 打不开）
  useEffect(() => {
    const missing = nodes.filter(
      (node) => node.kind === 'image' && node.image && !imageCache[node.image.src],
    )
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      for (const node of missing) {
        const src = node.image?.src
        if (!src || src.startsWith('http') || src.startsWith('data:')) continue
        try {
          const file = await rpc.readImage(src)
          if (cancelled) return
          setImageCache((current) => ({ ...current, [src]: file.dataUrl }))
        } catch {
          /* 读不到就不渲染图片本体，节点仍在，不会丢数据 */
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [imageCache, nodes])

  const chartNode = nodes.find((node) => node.id === chartTarget) ?? null

  if (!activePath || !doc) return null


  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <input
          value={doc.title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label={t('canvas.title')}
          className="h-7 min-w-0 max-w-64 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-sm font-medium outline-none transition-colors hover:border-border focus:border-ring/60 focus:bg-background"
        />
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {saveState === 'saving' ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              {t('editor.saving')}
            </span>
          ) : dirty ? (
            t('editor.unsaved')
          ) : saveState === 'saved' ? (
            t('editor.saved')
          ) : null}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Hint label={`${t('canvas.addNode')} (双击空白)`}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('canvas.addNode')}
              onClick={() => {
                const id = addNode(80 - view.tx / view.scale, 80 - view.ty / view.scale, '')
                setSelected(id)
                setEditing(id)
              }}
            >
              <Plus className="size-4" />
            </Button>
          </Hint>
          <Hint label={t('canvas.tidy')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('canvas.tidy')} onClick={tidy}>
              <LayoutGrid className="size-4" />
            </Button>
          </Hint>
          <div className="mx-1 flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
            <button
              type="button"
              aria-label={t('canvas.zoomOut')}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              onClick={() => setView((current) => ({ ...current, scale: Math.max(MIN_SCALE, current.scale - 0.1) }))}
            >
              <Minus className="size-3.5" />
            </button>
            <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">
              {Math.round(view.scale * 100)}%
            </span>
            <button
              type="button"
              aria-label={t('canvas.zoomIn')}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              onClick={() => setView((current) => ({ ...current, scale: Math.min(MAX_SCALE, current.scale + 0.1) }))}
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <Hint label={t('canvas.fit')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('canvas.fit')} onClick={fitToContent}>
              <Frame className="size-4" />
            </Button>
          </Hint>
          <Hint label={t('canvas.reset')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('canvas.reset')}
              onClick={() => setView({ scale: 1, tx: 0, ty: 0 })}
            >
              <Maximize2 className="size-4" />
            </Button>
          </Hint>
          <Hint label={t('common.save')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.save')}
              onClick={() => void save({ force: true })}
            >
              <Save className="size-4" />
            </Button>
          </Hint>
          <Hint label={t('common.close')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.close')}
              onClick={() => {
                void flushCanvasSave()
                close()
              }}
            >
              <X className="size-4" />
            </Button>
          </Hint>
        </div>
      </div>

      <div
        ref={boardRef}
        data-canvas-board="1"
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget && !(event.target as HTMLElement).dataset.board) return
          const world = toWorld(event.clientX, event.clientY)
          // 铅笔 / 荧光笔：按下起笔，抬起收成一条笔迹
          if (tool === 'pen' || tool === 'highlighter') {
            drawRef.current = { mode: tool, points: [[world.x, world.y]] }
            setStrokeDraft([[world.x, world.y]])
            return
          }
          panRef.current = { startX: event.clientX, startY: event.clientY, tx: view.tx, ty: view.ty }
          setSelected('')
          setLinkFrom('')
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onDoubleClick={(event) => {
          const world = toWorld(event.clientX, event.clientY)
          const id = addNode(world.x - NODE_W / 2, world.y - NODE_H / 2, '')
          setSelected(id)
          // 「插入节点后」设为返回选择工具时，不进入编辑态
          if (canvasSettings.afterInsert === 'keep') setEditing(id)
        }}
        onWheel={handleWheel}
        onDragOver={(event) => {
          // 拖图形库里的项到画布上，落点就是插入位置
          if (event.dataTransfer.types.includes('application/x-canvas-shape')) event.preventDefault()
        }}
        onDrop={(event) => {
          const type = event.dataTransfer.getData('application/x-canvas-shape')
          if (!type) return
          event.preventDefault()
          insertShape(type as CanvasShapeType, toWorld(event.clientX, event.clientY))
        }}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-muted/20',
          tool === 'pan' && 'cursor-grab active:cursor-grabbing',
          (tool === 'pen' || tool === 'highlighter') && 'cursor-crosshair',
          tool === 'eraser' && 'cursor-cell',
        )}
        style={{
          backgroundImage: gridBackground,
          backgroundSize: `${gridGap * view.scale}px ${gridGap * view.scale}px`,
          backgroundPosition: `${view.tx}px ${view.ty}px`,
        }}
      >
        <div data-board="1" className="absolute inset-0" />

        {/* 左侧工具条：选择 / 平移 / 铅笔 / 荧光笔 / 橡皮 / 图形库 / 数据图表 / 图片 */}
        <div
          data-canvas-tools
          className="absolute top-3 left-3 z-10 flex flex-col gap-0.5 rounded-xl border border-border bg-background/90 p-1 shadow-sm backdrop-blur"
        >
          {TOOLS.map((item, index) => {
            const Icon = item.icon
            const active = tool === item.value
            return (
              <div key={item.value}>
                {index === 2 || index === 5 ? <div className="my-0.5 h-px bg-border" /> : null}
                <Hint label={`${t(item.labelKey)} · ${item.key.toUpperCase()}`}>
                  <button
                    type="button"
                    aria-label={t(item.labelKey)}
                    aria-pressed={active}
                    data-canvas-tool={item.value}
                    onClick={() => {
                      setTool(item.value)
                      setLinkFrom('')
                      setShapePanel(false)
                      setChartTarget('')
                    }}
                    className={cn(
                      'flex size-8 items-center justify-center rounded-lg transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                </Hint>
                {index === 4 ? <div className="my-0.5 h-px bg-border" /> : null}
              </div>
            )
          })}

          <Hint label={t('canvas.shapes.title')}>
            <button
              type="button"
              aria-label={t('canvas.shapes.title')}
              aria-pressed={shapePanel}
              data-canvas-tool="shapes"
              onClick={() => {
                setShapePanel((open) => !open)
                setChartTarget('')
              }}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg transition-colors',
                shapePanel
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Shapes className="size-4" />
            </button>
          </Hint>
          <Hint label={t('canvas.chart.title')}>
            <button
              type="button"
              aria-label={t('canvas.chart.title')}
              aria-pressed={Boolean(chartTarget)}
              data-canvas-tool="chart"
              onClick={() => {
                if (chartTarget) {
                  setChartTarget('')
                  return
                }
                insertChart()
              }}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg transition-colors',
                chartTarget
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <ChartNoAxesCombined className="size-4" />
            </button>
          </Hint>
          <Hint label={t('canvas.image')}>
            <button
              type="button"
              aria-label={t('canvas.image')}
              data-canvas-tool="image"
              onClick={() => fileRef.current?.click()}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ImagePlus className="size-4" />
            </button>
          </Hint>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          data-canvas-image-input
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void insertImageFile(file).catch((error) =>
                toast.error(error instanceof Error ? error.message : String(error)),
              )
            }
          }}
        />

        {shapePanel ? (
          <ShapeLibrary
            onInsert={(type) => insertShape(type)}
            onClose={() => setShapePanel(false)}
            onDragStart={() => undefined}
          />
        ) : null}

        {chartNode?.chart ? (
          <ChartPanel
            spec={chartNode.chart}
            onChange={(next: CanvasChartSpec) => updateNode(chartNode.id, { chart: next })}
            onClose={() => setChartTarget('')}
          />
        ) : null}

        {canvasSettings.minimap && minimap.boxes.length > 0 ? (
          <div
            data-minimap="1"
            role="presentation"
            onPointerDown={(event) => {
              // 点小地图直接跳到对应位置（与参考实现的缩略图导航一致）
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              if (rect.width === 0 || rect.height === 0) return
              const ratioX = (event.clientX - rect.left) / rect.width
              const ratioY = (event.clientY - rect.top) / rect.height
              const worldX = minimap.span.left + ratioX * minimap.span.spanX
              const worldY = minimap.span.top + ratioY * minimap.span.spanY
              setView((current) => ({
                ...current,
                tx: board.w / 2 - worldX * current.scale,
                ty: board.h / 2 - worldY * current.scale,
              }))
            }}
            className="absolute right-3 bottom-3 size-24 cursor-pointer overflow-hidden rounded-md border border-border bg-background/85"
          >
            {minimap.boxes.map((item) => (
              <span
                key={item.id}
                className="absolute rounded-[1px] bg-primary/50"
                style={{
                  left: `${item.left}%`,
                  top: `${item.top}%`,
                  width: `${item.width}%`,
                  height: `${item.height}%`,
                }}
              />
            ))}
            {minimap.viewport ? (
              <span
                data-minimap-viewport="1"
                className="pointer-events-none absolute rounded-[2px] border border-primary/70"
                style={{
                  left: `${minimap.viewport.left}%`,
                  top: `${minimap.viewport.top}%`,
                  width: `${minimap.viewport.width}%`,
                  height: `${minimap.viewport.height}%`,
                }}
              />
            ) : null}
          </div>
        ) : null}

        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
        >
          <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
            {doc.edges.map((edge) => {
              const from = nodeMap.get(edge.from)
              const to = nodeMap.get(edge.to)
              if (!from || !to) return null
              const fromSize = nodeSize(from)
              const toSize = nodeSize(to)
              const x1 = from.x + fromSize.w
              const y1 = from.y + fromSize.h / 2
              const x2 = to.x
              const y2 = to.y + toSize.h / 2
              const mid = Math.max(40, Math.abs(x2 - x1) / 2)
              return (
                <path
                  key={edge.id}
                  data-canvas-edge={edge.id}
                  d={`M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="hsl(var(--primary) / 0.55)"
                  strokeWidth={1.6}
                  className="pointer-events-auto cursor-pointer"
                  onClick={() => removeEdge(edge.id)}
                />
              )
            })}
          </svg>

          {/* 手绘中的临时笔迹 */}
          {strokeDraft.length > 1 ? (
            <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
              <path
                d={strokePath(strokeDraft)}
                fill="none"
                stroke={tool === 'pen' ? 'hsl(var(--foreground))' : 'rgb(250 204 21 / 0.45)'}
                strokeWidth={tool === 'pen' ? 2.2 : 16}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}

          {nodes.map((node) => {
            const active = selected === node.id
            const linking = linkFrom === node.id
            const size = nodeSize(node)
            const kind = node.kind ?? 'card'
            const editingThis = editing === node.id
            return (
              <div
                key={node.id}
                data-canvas-node={node.id}
                data-canvas-kind={kind}
                onPointerDown={(event) => handleNodePointerDown(event, node)}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  // 图表双击开数据面板，图片/笔迹没有可编辑文本
                  if (kind === 'chart') {
                    setChartTarget(node.id)
                    return
                  }
                  if (kind === 'image' || kind === 'freehand') return
                  setEditing(node.id)
                }}
                style={{ left: node.x, top: node.y, width: size.w, minHeight: size.h }}
                className={cn(
                  'group absolute',
                  kind === 'card'
                    ? 'flex cursor-grab flex-col rounded-lg border bg-card p-2.5 shadow-sm transition-shadow'
                    : 'cursor-grab',
                  kind === 'card' && (active ? 'border-primary/70 ring-1 ring-primary/30' : 'border-border'),
                  linking && 'ring-2 ring-primary/40',
                )}
              >
                {kind === 'card' ? (
                  <>
                    {editingThis ? (
                      <textarea
                        autoFocus
                        value={node.text}
                        onChange={(event) => updateNode(node.id, { text: event.target.value })}
                        onBlur={() => setEditing('')}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setEditing('')
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault()
                            setEditing('')
                          }
                        }}
                        placeholder={t('canvas.nodePlaceholder')}
                        className="min-h-12 w-full resize-none bg-transparent text-sm leading-relaxed outline-none"
                      />
                    ) : (
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">
                        {node.text || (
                          <span className="text-muted-foreground/70">{t('canvas.nodeEmpty')}</span>
                        )}
                      </p>
                    )}
                  </>
                ) : null}

                {kind === 'shape' ? (
                  <>
                    <CanvasShapeArt type={node.shape ?? 'process'} />
                    <div className="relative flex size-full items-center justify-center px-2 py-1 text-center">
                      {editingThis ? (
                        <textarea
                          autoFocus
                          value={node.text}
                          onChange={(event) => updateNode(node.id, { text: event.target.value })}
                          onBlur={() => setEditing('')}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditing('')
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault()
                              setEditing('')
                            }
                          }}
                          placeholder={t('canvas.nodePlaceholder')}
                          className="w-full resize-none bg-transparent text-center text-[13px] leading-snug outline-none"
                        />
                      ) : (
                        <span className="max-w-full text-[13px] leading-snug break-words whitespace-pre-wrap">
                          {node.text || (
                            <span className="text-muted-foreground/70">{t('canvas.shape.empty')}</span>
                          )}
                        </span>
                      )}
                    </div>
                  </>
                ) : null}

                {kind === 'chart' ? (
                  <div className="size-full overflow-hidden rounded-lg border border-border bg-card p-1.5 shadow-sm">
                    <CanvasChartArt spec={node.chart ?? defaultChartSpec()} />
                  </div>
                ) : null}

                {kind === 'image' ? (
                  <div className="size-full overflow-hidden rounded-lg border border-border bg-card">
                    {node.image && imageCache[node.image.src] ? (
                      <img
                        src={imageCache[node.image.src]}
                        alt={node.image.name}
                        draggable={false}
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center px-2 text-center text-[11px] text-muted-foreground">
                        {node.image?.name || t('canvas.image')}
                      </div>
                    )}
                  </div>
                ) : null}

                {kind === 'freehand' && node.stroke ? (
                  <svg
                    className="overflow-visible"
                    width={size.w}
                    height={size.h}
                    aria-hidden="true"
                    data-canvas-stroke={node.stroke.mode}
                  >
                    <path
                      d={strokePath(node.stroke.points)}
                      fill="none"
                      stroke={node.stroke.color}
                      strokeWidth={node.stroke.width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}

                {/* 非卡片节点用一圈描边表示选中 */}
                {active && kind !== 'card' ? (
                  <span className="pointer-events-none absolute -inset-1 rounded-lg ring-2 ring-primary/50" />
                ) : null}

                {/* 悬浮工具：连线 / 删除 */}
                <div
                  className={cn(
                    'absolute -top-2 right-0 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100',
                    active && 'opacity-100',
                  )}
                >
                  {kind !== 'freehand' ? (
                    <button
                      type="button"
                      aria-label={t('canvas.connect')}
                      className="flex size-4 items-center justify-center rounded-full border border-primary/60 bg-background text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        setLinkFrom(node.id)
                      }}
                    >
                      <Link2 className="size-2.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    className="flex size-4 items-center justify-center rounded bg-background text-muted-foreground transition-colors hover:text-destructive"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      removeNode(node.id)
                    }}
                  >
                    <Eraser className="size-3" />
                  </button>
                </div>

                {/* 缩放手柄：图形 / 图表 / 图片可以拉大小 */}
                {active && (kind === 'shape' || kind === 'chart' || kind === 'image') ? (
                  <button
                    type="button"
                    aria-label={t('canvas.resize')}
                    data-canvas-resize={node.id}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      resizeRef.current = {
                        id: node.id,
                        startX: event.clientX,
                        startY: event.clientY,
                        w: size.w,
                        h: size.h,
                      }
                    }}
                    className="absolute -right-1 -bottom-1 size-2.5 cursor-nwse-resize rounded-full border border-primary bg-background"
                  />
                ) : null}
              </div>
            )
          })}

        </div>

        {nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('canvas.empty')}</p>
            <p className="text-xs text-muted-foreground/70">{t('canvas.emptyHint')}</p>
          </div>
        ) : null}

        {linkFrom ? (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[11px] text-primary-foreground shadow">
            {t('canvas.connectHint')}
          </div>
        ) : null}
      </div>
    </div>
  )
}
