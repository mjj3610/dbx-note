/**
 * 画布图形库
 *
 * 与参考实现 `lib/canvas/shapes.ts` 的类型集合保持一致：17 种流程图 / 数据结构图形，
 * 另加「文本」这一项（图形库里可以当纯文字标签用）。
 * 轮廓统一画在 200×100 的 viewBox 里，靠 `preserveAspectRatio="none"` 拉伸，
 * 所以同一套 path 能适配任意尺寸，不用按尺寸重算。
 */

export const FLOWCHART_SHAPE_TYPES = [
  'process',
  'decision',
  'terminator',
  'input-output',
  'document',
  'multi-document',
  'predefined-process',
  'manual-input',
  'preparation',
  'delay',
  'display',
  'connector',
  'off-page-connector',
  'internal-storage',
  'database',
  'stored-data',
] as const

export type CanvasFlowchartShape = (typeof FLOWCHART_SHAPE_TYPES)[number]

/** 图形库里可插入的形状：流程图图形 + 文本 */
export type CanvasShapeType = CanvasFlowchartShape | 'text'

export interface ShapeGroup {
  id: 'common' | 'flowchart' | 'data'
  titleKey: string
  types: CanvasShapeType[]
}

/** 图形库面板的分组与顺序（常用 → 流程图 → 数据与存储） */
export const SHAPE_GROUPS: ShapeGroup[] = [
  { id: 'common', titleKey: 'canvas.shapes.common', types: ['process', 'decision', 'terminator', 'text'] },
  {
    id: 'flowchart',
    titleKey: 'canvas.shapes.flowchart',
    types: [
      'input-output',
      'document',
      'multi-document',
      'predefined-process',
      'manual-input',
      'preparation',
      'delay',
      'display',
      'connector',
      'off-page-connector',
    ],
  },
  { id: 'data', titleKey: 'canvas.shapes.data', types: ['internal-storage', 'database', 'stored-data'] },
]

/** 图形名（i18n key 后缀，与参考实现的 `nodes.*` 一一对应） */
export const SHAPE_LABEL_KEYS: Record<CanvasShapeType, string> = {
  process: 'canvas.shape.process',
  decision: 'canvas.shape.decision',
  terminator: 'canvas.shape.terminator',
  text: 'canvas.shape.text',
  'input-output': 'canvas.shape.inputOutput',
  document: 'canvas.shape.document',
  'multi-document': 'canvas.shape.multiDocument',
  'predefined-process': 'canvas.shape.predefinedProcess',
  'manual-input': 'canvas.shape.manualInput',
  preparation: 'canvas.shape.preparation',
  delay: 'canvas.shape.delay',
  display: 'canvas.shape.display',
  connector: 'canvas.shape.connector',
  'off-page-connector': 'canvas.shape.offPageConnector',
  'internal-storage': 'canvas.shape.internalStorage',
  database: 'canvas.shape.database',
  'stored-data': 'canvas.shape.storedData',
}

export function isFlowchartShape(value: unknown): value is CanvasFlowchartShape {
  return typeof value === 'string' && (FLOWCHART_SHAPE_TYPES as readonly string[]).includes(value)
}

/** 插入时的默认尺寸：判断条件要方一点，连接符是正圆，文本条最扁 */
export function shapeDefaultSize(type: CanvasShapeType): { w: number; h: number } {
  if (type === 'decision') return { w: 144, h: 144 }
  if (type === 'connector') return { w: 96, h: 96 }
  if (type === 'off-page-connector') return { w: 120, h: 100 }
  if (type === 'text') return { w: 160, h: 44 }
  return { w: 192, h: 80 }
}
