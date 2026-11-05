import { useMemo } from 'react'

import { seriesColor, type CanvasChartSpec } from '@/lib/canvasChart'

/**
 * 数据图表渲染
 *
 * 纯 SVG 自绘（不引图表库）：六种类型共用同一套刻度与配色，
 * 内部坐标系固定 400×260 再整体缩放到节点尺寸，缩放时文字不会跟着拉变形。
 */
const W = 400
const H = 260
const PAD = { left: 46, right: 16, top: 30, bottom: 34 }

function niceMax(value: number): number {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const scaled = value / base
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return step * base
}

function polar(cx: number, cy: number, radius: number, angle: number) {
  const radians = (angle - 90) * (Math.PI / 180)
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)] as const
}

function arcPath(cx: number, cy: number, radius: number, start: number, end: number) {
  const [x1, y1] = polar(cx, cy, radius, start)
  const [x2, y2] = polar(cx, cy, radius, end)
  const large = end - start > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`
}

export function CanvasChartArt({ spec }: { spec: CanvasChartSpec }) {
  const series = spec.series.length > 0 ? spec.series : [{ name: '数值' }]
  const data = spec.data.length > 0 ? spec.data : [{ label: '', values: [0] }]

  const view = useMemo(() => {
    const plotW = W - PAD.left - PAD.right
    const plotH = H - PAD.top - PAD.bottom
    const maxValue = niceMax(Math.max(1, ...data.flatMap((datum) => datum.values.map((value) => Math.abs(value)))))
    return { plotW, plotH, maxValue }
  }, [data])

  const axisText = 'fill-muted-foreground text-[9px]'
  const gridStroke = 'stroke-border'
  const zeroY = PAD.top + view.plotH

  /** 分组柱状图 / 折线 / 面积都按类目均分横轴 */
  const bandWidth = view.plotW / Math.max(1, data.length)
  const xAt = (index: number) => PAD.left + bandWidth * (index + 0.5)
  const yAt = (value: number) => zeroY - (value / view.maxValue) * view.plotH

  const linePath = (seriesIndex: number) =>
    data
      .map((datum, index) => `${index === 0 ? 'M' : 'L'} ${xAt(index)} ${yAt(datum.values[seriesIndex] ?? 0)}`)
      .join(' ')

  const areaPath = (seriesIndex: number) =>
    `${linePath(seriesIndex)} L ${xAt(data.length - 1)} ${zeroY} L ${xAt(0)} ${zeroY} Z`

  const axis = (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <g key={ratio}>
          <line
            className={gridStroke}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={zeroY - view.plotH * ratio}
            y2={zeroY - view.plotH * ratio}
            strokeDasharray={ratio === 0 ? undefined : '3 4'}
            strokeWidth={1}
            opacity={ratio === 0 ? 0.7 : 0.35}
          />
          <text
            className={axisText}
            x={PAD.left - 6}
            y={zeroY - view.plotH * ratio + 3}
            textAnchor="end"
          >
            {Math.round(view.maxValue * ratio)}
          </text>
        </g>
      ))}
      {data.map((datum, index) => (
        <text key={datum.label + index} className={axisText} x={xAt(index)} y={H - PAD.bottom + 14} textAnchor="middle">
          {datum.label.length > 6 ? `${datum.label.slice(0, 6)}…` : datum.label}
        </text>
      ))}
    </>
  )

  const title = spec.title ? (
    <text className="fill-foreground text-[11px] font-medium" x={PAD.left} y={16}>
      {spec.title}
    </text>
  ) : null

  const legend = (
    <g>
      {series.map((item, index) => (
        <g key={item.name + index} transform={`translate(${W - PAD.right - 90}, ${18 + index * 14})`}>
          <rect width="8" height="8" rx="2" fill={seriesColor(index)} />
          <text className="fill-muted-foreground text-[9px]" x="12" y="7.5">
            {item.name.length > 8 ? `${item.name.slice(0, 8)}…` : item.name}
          </text>
        </g>
      ))}
    </g>
  )

  return (
    <svg
      className="size-full"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={spec.title || spec.categoryLabel}
      data-canvas-chart={spec.type}
    >
      {title}

      {(spec.type === 'bar' || spec.type === 'line' || spec.type === 'area') && (
        <>
          {axis}
          {spec.type === 'area' &&
            series.map((item, index) => (
              <path
                key={`area-${item.name}-${index}`}
                d={areaPath(index)}
                fill={seriesColor(index)}
                opacity={0.18}
              />
            ))}
          {spec.type === 'bar' &&
            data.map((datum, dataIndex) =>
              series.map((item, seriesIndex) => {
                const barWidth = (bandWidth * 0.66) / series.length
                const value = datum.values[seriesIndex] ?? 0
                const top = yAt(value)
                return (
                  <rect
                    key={`bar-${datum.label}-${item.name}-${seriesIndex}`}
                    x={xAt(dataIndex) - (bandWidth * 0.66) / 2 + seriesIndex * barWidth}
                    y={Math.min(top, zeroY)}
                    width={Math.max(2, barWidth - 2)}
                    height={Math.max(1, Math.abs(zeroY - top))}
                    rx={3}
                    fill={seriesColor(seriesIndex)}
                    opacity={0.9}
                  />
                )
              }),
            )}
          {(spec.type === 'line' || spec.type === 'area') &&
            series.map((item, index) => (
              <g key={`line-${item.name}-${index}`}>
                <path d={linePath(index)} fill="none" stroke={seriesColor(index)} strokeWidth={2} strokeLinejoin="round" />
                {data.map((datum, dataIndex) => (
                  <circle
                    key={`dot-${datum.label}-${dataIndex}`}
                    cx={xAt(dataIndex)}
                    cy={yAt(datum.values[index] ?? 0)}
                    r={2.6}
                    fill={seriesColor(index)}
                  />
                ))}
              </g>
            ))}
        </>
      )}

      {spec.type === 'pie' && (
        <>
          {(() => {
            const cx = W / 2 - 40
            const cy = H / 2 + 6
            const radius = Math.min(view.plotH, view.plotW) * 0.42
            const values = data.map((datum) => Math.max(0, datum.values[0] ?? 0))
            const total = values.reduce((sum, value) => sum + value, 0) || 1
            let angle = 0
            return data.map((datum, index) => {
              const sweep = (values[index] / total) * 360
              const path = arcPath(cx, cy, radius, angle, Math.min(360, angle + sweep))
              angle += sweep
              return (
                <g key={`slice-${datum.label}-${index}`}>
                  <path d={path} fill={seriesColor(index)} opacity={0.9} />
                  <g transform={`translate(${W - 118}, ${76 + index * 16})`}>
                    <rect width="8" height="8" rx="2" fill={seriesColor(index)} />
                    <text className="fill-muted-foreground text-[9px]" x="12" y="7.5">
                      {datum.label} · {Math.round((values[index] / total) * 100)}%
                    </text>
                  </g>
                </g>
              )
            })
          })()}
        </>
      )}

      {spec.type === 'radar' && (
        <>
          {(() => {
            const cx = W / 2
            const cy = H / 2 + 8
            const radius = Math.min(view.plotH, view.plotW) * 0.42
            const count = data.length
            const rings = [0.25, 0.5, 0.75, 1]
            return (
              <>
                {rings.map((ring) => (
                  <polygon
                    key={`ring-${ring}`}
                    points={data
                      .map((_, index) => polar(cx, cy, radius * ring, (360 / count) * index).join(','))
                      .join(' ')}
                    className="fill-none stroke-border"
                    strokeWidth={1}
                    opacity={0.5}
                  />
                ))}
                {data.map((datum, index) => {
                  const [x, y] = polar(cx, cy, radius + 12, (360 / count) * index)
                  return (
                    <text key={`axis-${datum.label}`} className={axisText} x={x} y={y} textAnchor="middle">
                      {datum.label.length > 5 ? `${datum.label.slice(0, 5)}…` : datum.label}
                    </text>
                  )
                })}
                {series.map((item, seriesIndex) => (
                  <polygon
                    key={`radar-${item.name}-${seriesIndex}`}
                    points={data
                      .map((datum, index) => {
                        const ratio = Math.min(1, Math.abs(datum.values[seriesIndex] ?? 0) / view.maxValue)
                        return polar(cx, cy, radius * ratio, (360 / count) * index).join(',')
                      })
                      .join(' ')}
                    fill={seriesColor(seriesIndex)}
                    fillOpacity={0.18}
                    stroke={seriesColor(seriesIndex)}
                    strokeWidth={2}
                  />
                ))}
              </>
            )
          })()}
        </>
      )}

      {spec.type === 'radial' && (
        <>
          {(() => {
            const cx = W / 2
            const cy = H / 2 + 6
            const base = Math.min(view.plotH, view.plotW) * 0.42
            return series.map((item, index) => {
              const total = data.reduce((sum, datum) => sum + Math.abs(datum.values[index] ?? 0), 0)
              const ratio = Math.min(1, total / Math.max(1, view.maxValue * Math.max(1, data.length) * 0.6))
              const radius = base * (1 - index * 0.22)
              const circumference = 2 * Math.PI * radius
              return (
                <g key={`radial-${item.name}-${index}`} transform={`rotate(-90 ${cx} ${cy})`}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={radius}
                    fill="none"
                    className="stroke-border"
                    strokeWidth={9}
                    opacity={0.45}
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={radius}
                    fill="none"
                    stroke={seriesColor(index)}
                    strokeWidth={9}
                    strokeLinecap="round"
                    strokeDasharray={`${circumference * ratio} ${circumference}`}
                  />
                </g>
              )
            })
          })()}
          {legend}
        </>
      )}

      {(spec.type === 'bar' || spec.type === 'line' || spec.type === 'area') && legend}
    </svg>
  )
}
