import {
  ArrowRightLeft,
  Box,
  Circle,
  Database,
  Diamond,
  FileStack,
  FileText,
  HardDrive,
  Hexagon,
  Keyboard,
  Monitor,
  PanelTop,
  Pentagon,
  RectangleHorizontal,
  Square,
  Timer,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SHAPE_GROUPS, SHAPE_LABEL_KEYS, type CanvasShapeType } from '@/lib/canvasShapes'
import { useT } from '@/lib/useT'

/** 图形库每项的图标，与参考实现的 `CANVAS_SHAPE_DEFINITIONS` 对齐 */
const SHAPE_ICONS: Record<CanvasShapeType, LucideIcon> = {
  process: RectangleHorizontal,
  decision: Diamond,
  terminator: Square,
  text: Type,
  'input-output': ArrowRightLeft,
  document: FileText,
  'multi-document': FileStack,
  'predefined-process': PanelTop,
  'manual-input': Keyboard,
  preparation: Hexagon,
  delay: Timer,
  display: Monitor,
  connector: Circle,
  'off-page-connector': Pentagon,
  'internal-storage': Box,
  database: Database,
  'stored-data': HardDrive,
}

/**
 * 图形库面板：常用图形 / 流程图 / 数据与存储三组
 *
 * 点一项就在画布中央落一个对应形状的节点；也可以拖到画布上指定位置。
 */
export function ShapeLibrary({
  onInsert,
  onClose,
  onDragStart,
}: {
  onInsert: (type: CanvasShapeType) => void
  onClose: () => void
  onDragStart: (type: CanvasShapeType) => void
}) {
  const t = useT()

  return (
    <div
      data-canvas-shapes-panel
      className="absolute top-3 left-16 z-20 flex max-h-[calc(100%-1.5rem)] w-64 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
    >
      <div className="flex h-10 shrink-0 items-center justify-between pl-3 pr-1.5">
        <span className="text-[13px] font-medium">{t('canvas.shapes.title')}</span>
        <Button variant="ghost" size="icon-sm" aria-label={t('common.close')} onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 pt-0">
        {SHAPE_GROUPS.map((group) => (
          <section key={group.id} className="mb-3 last:mb-0" data-shape-group={group.id}>
            <h3 className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">
              {t(group.titleKey)}
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              {group.types.map((type) => {
                const Icon = SHAPE_ICONS[type]
                return (
                  <button
                    key={type}
                    type="button"
                    data-canvas-shape-item={type}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy'
                      event.dataTransfer.setData('application/x-canvas-shape', type)
                      onDragStart(type)
                    }}
                    onClick={() => onInsert(type)}
                    className="flex h-9 min-w-0 items-center gap-1.5 rounded-lg border border-border px-2 text-left text-[12px] font-normal transition-colors hover:bg-muted"
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{t(SHAPE_LABEL_KEYS[type])}</span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
