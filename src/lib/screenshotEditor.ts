/**
 * 截图编辑器的绘制与导出
 *
 * 坐标约定：选区与标注都存**视口坐标**（图片按窗口等比缩放后的显示尺寸），
 * 导出时按 `naturalWidth / viewport.width` 换算回原图分辨率，
 * 这样缩放窗口不会改变成品清晰度，也不需要每次都换算标注点。
 */
export interface Point {
  x: number
  y: number
}

export interface Rect extends Point {
  width: number
  height: number
}

export type ShotTool = 'select' | 'rectangle' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic'
export type DrawTool = Exclude<ShotTool, 'select'>

export interface Annotation {
  id: string
  tool: DrawTool
  points: Point[]
  color: string
  width: number
  text?: string
}

/** 工具条顺序与快捷键（对齐参考实现） */
export const SHOT_TOOLS: Array<{ tool: ShotTool; shortcut: string; key: string }> = [
  { tool: 'select', shortcut: 'V', key: 'shot.tool.select' },
  { tool: 'rectangle', shortcut: 'R', key: 'shot.tool.rectangle' },
  { tool: 'ellipse', shortcut: 'O', key: 'shot.tool.ellipse' },
  { tool: 'arrow', shortcut: 'A', key: 'shot.tool.arrow' },
  { tool: 'pen', shortcut: 'P', key: 'shot.tool.pen' },
  { tool: 'text', shortcut: 'T', key: 'shot.tool.text' },
  { tool: 'mosaic', shortcut: 'M', key: 'shot.tool.mosaic' },
]

export const SHOT_COLORS = [
  '#ef4444',
  '#f97316',
  '#facc15',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ffffff',
  '#171717',
]

export const SHOT_WIDTHS = [2, 3, 5, 8]

export function rectFromPoints(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

export function clampPoint(point: Point, width: number, height: number): Point {
  return {
    x: Math.max(0, Math.min(width, point.x)),
    y: Math.max(0, Math.min(height, point.y)),
  }
}

export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** 马赛克：把已绘制区域的像素按块降采样再放大回去 */
function pixelate(context: CanvasRenderingContext2D, rect: Rect, width: number) {
  if (rect.width < 1 || rect.height < 1) return
  const transform = context.getTransform()
  const origin = transform.transformPoint(rect)
  const end = transform.transformPoint({ x: rect.x + rect.width, y: rect.y + rect.height })
  const left = Math.max(0, Math.floor(origin.x))
  const top = Math.max(0, Math.floor(origin.y))
  const right = Math.min(context.canvas.width, Math.ceil(end.x))
  const bottom = Math.min(context.canvas.height, Math.ceil(end.y))
  if (right <= left || bottom <= top) return

  const block = Math.max(10, width * 6)
  const sample = document.createElement('canvas')
  sample.width = Math.max(1, Math.ceil(rect.width / block))
  sample.height = Math.max(1, Math.ceil(rect.height / block))
  const sampleContext = sample.getContext('2d')
  if (!sampleContext) return
  sampleContext.drawImage(
    context.canvas,
    left,
    top,
    right - left,
    bottom - top,
    0,
    0,
    sample.width,
    sample.height,
  )
  context.save()
  context.beginPath()
  context.rect(rect.x, rect.y, rect.width, rect.height)
  context.clip()
  context.imageSmoothingEnabled = false
  context.drawImage(sample, rect.x, rect.y, rect.width, rect.height)
  context.restore()
}

/** 把一组标注画到当前上下文上（矩形 / 椭圆 / 箭头 / 画笔 / 文字 / 马赛克） */
export function drawAnnotations(
  context: CanvasRenderingContext2D,
  annotations: readonly Annotation[],
) {
  for (const annotation of annotations) {
    const start = annotation.points[0]
    const end = annotation.points[annotation.points.length - 1]
    if (!start || !end) continue
    const rect = rectFromPoints(start, end)

    if (annotation.tool === 'mosaic') {
      pixelate(context, rect, annotation.width)
      continue
    }

    context.save()
    context.strokeStyle = annotation.color
    context.fillStyle = annotation.color
    context.lineWidth = annotation.width
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()

    if (annotation.tool === 'rectangle') {
      context.strokeRect(rect.x, rect.y, rect.width, rect.height)
    } else if (annotation.tool === 'ellipse') {
      context.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        Math.max(0.5, rect.width / 2),
        Math.max(0.5, rect.height / 2),
        0,
        0,
        Math.PI * 2,
      )
      context.stroke()
    } else if (annotation.tool === 'arrow') {
      context.moveTo(start.x, start.y)
      context.lineTo(end.x, end.y)
      context.stroke()
      const angle = Math.atan2(end.y - start.y, end.x - start.x)
      const head = Math.max(10, annotation.width * 4)
      context.beginPath()
      context.moveTo(end.x, end.y)
      context.lineTo(
        end.x - head * Math.cos(angle - Math.PI / 6),
        end.y - head * Math.sin(angle - Math.PI / 6),
      )
      context.lineTo(
        end.x - head * Math.cos(angle + Math.PI / 6),
        end.y - head * Math.sin(angle + Math.PI / 6),
      )
      context.closePath()
      context.fill()
    } else if (annotation.tool === 'pen') {
      if (annotation.points.length === 1) {
        context.arc(start.x, start.y, Math.max(1, annotation.width / 2), 0, Math.PI * 2)
        context.fill()
      } else {
        context.moveTo(start.x, start.y)
        for (const point of annotation.points.slice(1)) context.lineTo(point.x, point.y)
        context.stroke()
      }
    } else if (annotation.tool === 'text') {
      const fontSize = Math.max(14, annotation.width * 6)
      context.font = `500 ${fontSize}px ui-sans-serif, -apple-system, "Segoe UI", sans-serif`
      context.textBaseline = 'top'
      // 文字支持换行：按 \n 逐行画，行高与参考项目 `lineHeight: 1.35` 一致
      for (const [index, line] of (annotation.text ?? '').split('\n').entries()) {
        context.fillText(line, start.x, start.y + index * fontSize * 1.35)
      }
    }
    context.restore()
  }
}

/**
 * 画布尺寸（视口像素），带 devicePixelRatio 以保持清晰
 *
 * `source` 允许传 ImageBitmap：浮层会先按「画布后备像素」把截图缩好再交给这里，
 * 于是 drawImage 是 1:1 贴图，不依赖 GPU 的大比例缩小重采样。
 *
 * `options.stage` 是**已经烘焙好的合成层**（图片 + 已提交标注）。拖动时每帧只贴这一张，
 * 不用把马赛克之类的标注重画一遍——参考项目里拖动手感丝滑靠的就是这一步，
 * 而我们原来每帧都重跑 `pixelate()`（画布自读回），一拖就卡。
 */
export function paintScene(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  viewport: { width: number; height: number },
  annotations: readonly Annotation[],
  options?: { dim?: boolean; selection?: Rect | null; draft?: Annotation | null; stage?: CanvasImageSource | null },
) {
  const { width, height } = viewport
  context.clearRect(0, 0, width, height)
  if (options?.stage) {
    context.drawImage(options.stage, 0, 0, width, height)
  } else {
    context.drawImage(source, 0, 0, width, height)
  }

  if (options?.dim) {
    const selection = options.selection
    context.save()
    context.fillStyle = 'rgba(0, 0, 0, 0.55)'
    if (selection && selection.width > 0 && selection.height > 0) {
      // 用「外框 + 挖洞」的方式压暗选区以外的部分
      context.beginPath()
      context.rect(0, 0, width, height)
      context.rect(selection.x, selection.y, selection.width, selection.height)
      context.fill('evenodd')
    } else {
      context.fillRect(0, 0, width, height)
    }
    context.restore()
  }

  // 合成层里已经有已提交的标注了，只补当前的草稿
  if (!options?.stage) drawAnnotations(context, annotations)
  if (options?.draft) drawAnnotations(context, [options.draft])
}

/**
 * 把「图片 + 已提交标注」烘焙进一张离屏画布
 *
 * 只在标注列表 / 底图 / 视口变化时调用一次；之后每帧只需 `drawImage(stage)`。
 */
export function composeStage(
  target: HTMLCanvasElement,
  source: CanvasImageSource,
  viewport: { width: number; height: number },
  annotations: readonly Annotation[],
  dpr: number,
) {
  const width = Math.max(1, Math.round(viewport.width * dpr))
  const height = Math.max(1, Math.round(viewport.height * dpr))
  // 尺寸没变就别重新赋值：给 canvas.width 赋同值也会重建后备存储（整块清零），很贵
  if (target.width !== width) target.width = width
  if (target.height !== height) target.height = height
  const context = target.getContext('2d')
  if (!context) return
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, viewport.width, viewport.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, viewport.width, viewport.height)
  drawAnnotations(context, annotations)
}

/**
 * 按选区裁剪并合成标注，返回 PNG base64
 *
 * 输出固定用原图分辨率：把整图按自然尺寸画到离屏画布，再切出选区，
 * 所以 2x DPI 的屏幕也能拿到真实像素。
 */
export async function cropSelection(
  image: HTMLImageElement,
  viewport: { width: number; height: number },
  selection: Rect | null,
  annotations: readonly Annotation[],
): Promise<{ dataBase64: string; width: number; height: number; mime: string }> {
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('截图还没准备好')

  const scaleX = image.naturalWidth / viewport.width
  const scaleY = image.naturalHeight / viewport.height
  const area = selection && selection.width > 1 ? selection : { x: 0, y: 0, width: viewport.width, height: viewport.height }

  const left = Math.max(0, Math.round(area.x * scaleX))
  const top = Math.max(0, Math.round(area.y * scaleY))
  const right = Math.min(image.naturalWidth, Math.round((area.x + area.width) * scaleX))
  const bottom = Math.min(image.naturalHeight, Math.round((area.y + area.height) * scaleY))
  if (right - left < 1 || bottom - top < 1) throw new Error('选区太小，换个区域再试')

  const full = document.createElement('canvas')
  full.width = image.naturalWidth
  full.height = image.naturalHeight
  const fullContext = full.getContext('2d')
  if (!fullContext) throw new Error('画布不可用')
  fullContext.scale(scaleX, scaleY)
  fullContext.drawImage(image, 0, 0, viewport.width, viewport.height)
  drawAnnotations(fullContext, annotations)

  const cropped = document.createElement('canvas')
  cropped.width = right - left
  cropped.height = bottom - top
  const croppedContext = cropped.getContext('2d')
  if (!croppedContext) throw new Error('画布不可用')
  croppedContext.drawImage(full, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height)

  const dataUrl = cropped.toDataURL('image/png')
  const comma = dataUrl.indexOf(',')
  return {
    dataBase64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
    width: cropped.width,
    height: cropped.height,
    mime: 'image/png',
  }
}
