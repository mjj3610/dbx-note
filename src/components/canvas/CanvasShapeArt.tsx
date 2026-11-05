import type { CSSProperties } from 'react'

import type { CanvasShapeType } from '@/lib/canvasShapes'
import { cn } from '@/lib/utils'

/**
 * 图形轮廓
 *
 * 所有 path 都画在 200×100 的 viewBox 里，`preserveAspectRatio="none"` 拉伸到节点尺寸，
 * 所以同一套轮廓能适配任意宽高；`vectorEffect="non-scaling-stroke"` 保证描边不被拉粗。
 * 轮廓数据与参考实现的 `canvas-nodes.tsx` 一致。
 */
export function CanvasShapeArt({
  type,
  className,
  style,
}: {
  type: CanvasShapeType
  className?: string
  style?: CSSProperties
}) {
  const shapeClassName = 'fill-card stroke-border'
  const merged = { vectorEffect: 'non-scaling-stroke', ...style } as CSSProperties
  // 文本图形不画轮廓，只当纯文字标签用
  if (type === 'text') return null

  return (
    <svg
      className={cn('absolute inset-0 size-full overflow-visible', className)}
      viewBox="0 0 200 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-canvas-shape={type}
    >
      {type === 'process' && (
        <rect className={shapeClassName} x="1" y="1" width="198" height="98" rx="8" style={merged} />
      )}
      {type === 'decision' && (
        <polygon className={shapeClassName} points="100,1 199,50 100,99 1,50" style={merged} />
      )}
      {type === 'terminator' && (
        <rect className={shapeClassName} x="1" y="1" width="198" height="98" rx="49" style={merged} />
      )}
      {type === 'input-output' && (
        <polygon className={shapeClassName} points="24,1 199,1 176,99 1,99" style={merged} />
      )}
      {type === 'document' && (
        <path
          className={shapeClassName}
          d="M1 1H199V80C160 60 132 100 99 81C65 61 35 100 1 82Z"
          style={merged}
        />
      )}
      {type === 'multi-document' && (
        <>
          <path
            className={shapeClassName}
            d="M15 1H199V73C163 57 137 90 106 75C76 60 49 90 15 75Z"
            style={merged}
          />
          <path
            className={shapeClassName}
            d="M8 9H192V81C156 65 130 98 99 83C69 68 42 98 8 83Z"
            style={merged}
          />
          <path
            className={shapeClassName}
            d="M1 17H185V89C149 73 123 106 92 91C62 76 35 106 1 91Z"
            style={merged}
          />
        </>
      )}
      {type === 'predefined-process' && (
        <>
          <rect className={shapeClassName} x="1" y="1" width="198" height="98" rx="6" style={merged} />
          <path className="fill-none stroke-border" d="M24 1V99M176 1V99" style={merged} />
        </>
      )}
      {type === 'manual-input' && (
        <polygon className={shapeClassName} points="1,25 199,1 199,99 1,99" style={merged} />
      )}
      {type === 'preparation' && (
        <polygon
          className={shapeClassName}
          points="28,1 172,1 199,50 172,99 28,99 1,50"
          style={merged}
        />
      )}
      {type === 'delay' && (
        <path
          className={shapeClassName}
          d="M1 1H126C167 1 199 23 199 50S167 99 126 99H1Z"
          style={merged}
        />
      )}
      {type === 'display' && (
        <path
          className={shapeClassName}
          d="M25 1H132C174 1 199 23 199 50S174 99 132 99H25C43 75 43 25 25 1Z"
          style={merged}
        />
      )}
      {type === 'connector' && (
        <ellipse className={shapeClassName} cx="100" cy="50" rx="49" ry="49" style={merged} />
      )}
      {type === 'off-page-connector' && (
        <polygon className={shapeClassName} points="1,1 199,1 199,66 100,99 1,66" style={merged} />
      )}
      {type === 'internal-storage' && (
        <>
          <rect className={shapeClassName} x="1" y="1" width="198" height="98" rx="4" style={merged} />
          <path className="fill-none stroke-border" d="M28 1V99M1 24H199" style={merged} />
        </>
      )}
      {type === 'database' && (
        <>
          <path
            className={shapeClassName}
            d="M1 17C1 8 45 1 100 1S199 8 199 17V83C199 92 155 99 100 99S1 92 1 83Z"
            style={merged}
          />
          <ellipse className="fill-none stroke-border" cx="100" cy="17" rx="99" ry="16" style={merged} />
        </>
      )}
      {type === 'stored-data' && (
        <path
          className={shapeClassName}
          d="M24 1H176C207 20 207 80 176 99H24C-7 80-7 20 24 1Z"
          style={merged}
        />
      )}
    </svg>
  )
}
