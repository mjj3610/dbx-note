/**
 * 知识图谱画布（0.5.9）
 *
 * 零新增依赖：纯内联 SVG + 一个有迭代上限的力导向布局。计算放在 useMemo 里
 * 一次算完（最多 70 轮 × 300 节点），不做持续 rAF 动画，避免图谱页签一直
 * 占用主线程影响输入与自动保存。缩放 / 平移只改 <g transform>，不重算布局。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'

import type { GraphEdge, GraphNode } from '@/lib/rpc'

interface Point {
  x: number
  y: number
}

interface View {
  x: number
  y: number
  scale: number
}

interface GraphCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selected: string | null
  keyword: string
  /** 递增即可触发「适应画布」 */
  fitToken: number
  onSelect: (id: string | null) => void
  onDiscover: (id: string) => void
}

/** 固定迭代次数的力导向：斥力 + 弹簧 + 向心力，最后夹在画布范围内 */
function computeLayout(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): Record<string, Point> {
  const points: Record<string, Point> = {}
  const velocity: Record<string, Point> = {}
  const total = nodes.length
  const radius = Math.min(width, height) * 0.34
  nodes.forEach((node, index) => {
    const angle = (index / Math.max(1, total)) * Math.PI * 2
    points[node.id] = {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    }
    velocity[node.id] = { x: 0, y: 0 }
  })
  if (total < 2) return points

  const validEdges = edges.filter((edge) => points[edge.source] && points[edge.target])
  const iterations = 70
  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations
    for (let left = 0; left < total; left += 1) {
      for (let right = left + 1; right < total; right += 1) {
        const a = points[nodes[left].id]
        const b = points[nodes[right].id]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let squared = dx * dx + dy * dy
        if (squared < 1) {
          dx = 0.1 + left * 0.001
          dy = 0.1
          squared = dx * dx + dy * dy
        }
        const distance = Math.sqrt(squared)
        const force = 2600 / squared
        const fx = (dx / distance) * force
        const fy = (dy / distance) * force
        velocity[nodes[left].id].x += fx
        velocity[nodes[left].id].y += fy
        velocity[nodes[right].id].x -= fx
        velocity[nodes[right].id].y -= fy
      }
    }
    for (const edge of validEdges) {
      const a = points[edge.source]
      const b = points[edge.target]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const rest = 110 + (1 - Math.min(1, edge.score)) * 70
      const force = (distance - rest) * 0.015 * (0.5 + edge.score)
      const fx = (dx / distance) * force
      const fy = (dy / distance) * force
      velocity[edge.source].x += fx
      velocity[edge.source].y += fy
      velocity[edge.target].x -= fx
      velocity[edge.target].y -= fy
    }
    for (const node of nodes) {
      const point = points[node.id]
      const speed = velocity[node.id]
      speed.x += (width / 2 - point.x) * 0.006
      speed.y += (height / 2 - point.y) * 0.006
      speed.x *= 0.78
      speed.y *= 0.78
      point.x += Math.max(-18, Math.min(18, speed.x * cooling))
      point.y += Math.max(-18, Math.min(18, speed.y * cooling))
      point.x = Math.max(44, Math.min(width - 44, point.x))
      point.y = Math.max(36, Math.min(height - 36, point.y))
    }
  }
  return points
}

export function GraphCanvas({
  nodes, edges, selected, keyword, fitToken, onSelect, onDiscover,
}: GraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null)
  const [size, setSize] = useState({ width: 900, height: 620 })
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setSize({ width: Math.max(320, rect.width), height: Math.max(240, rect.height) })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const points = useMemo(
    () => computeLayout(nodes, edges, size.width, size.height),
    [nodes, edges, size.width, size.height],
  )

  const fit = useCallback(() => {
    const all = Object.values(points)
    if (all.length === 0) {
      setView({ x: 0, y: 0, scale: 1 })
      return
    }
    const minX = Math.min(...all.map((point) => point.x))
    const maxX = Math.max(...all.map((point) => point.x))
    const minY = Math.min(...all.map((point) => point.y))
    const maxY = Math.max(...all.map((point) => point.y))
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const boxWidth = Math.max(1, maxX - minX)
    const boxHeight = Math.max(1, maxY - minY)
    const scale = Math.max(
      0.35,
      Math.min(1.6, Math.min((size.width - 96) / boxWidth, (size.height - 96) / boxHeight)),
    )
    setView({ x: size.width / 2 - centerX * scale, y: size.height / 2 - centerY * scale, scale })
  }, [points, size.width, size.height])

  useEffect(() => {
    fit()
  }, [fitToken, fit])

  /** 选中节点 + 一跳邻居高亮，其余淡化 */
  const highlighted = useMemo(() => {
    if (!selected) return null
    const set = new Set<string>([selected])
    for (const edge of edges) {
      if (edge.source === selected) set.add(edge.target)
      if (edge.target === selected) set.add(edge.source)
    }
    return set
  }, [selected, edges])

  const matched = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    if (!needle) return null
    return new Set(
      nodes
        .filter((node) => `${node.label} ${node.path} ${node.excerpt}`.toLowerCase().includes(needle))
        .map((node) => node.id),
    )
  }, [keyword, nodes])

  const dimmed = (id: string): boolean =>
    (highlighted !== null && !highlighted.has(id)) || (matched !== null && !matched.has(id))

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest('[data-graph-node]')) return
    dragRef.current = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelect(null)
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setView((current) => ({
      ...current,
      x: drag.viewX + (event.clientX - drag.x),
      y: drag.viewY + (event.clientY - drag.y),
    }))
  }

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    const factor = event.deltaY > 0 ? 0.9 : 1.1
    setView((current) => ({
      ...current,
      scale: Math.max(0.35, Math.min(3, current.scale * factor)),
    }))
  }

  return (
    <div
      ref={hostRef}
      className="relative h-full min-h-0 w-full overflow-hidden bg-background"
      data-graph-canvas="1"
      data-graph-node-count={nodes.length}
      data-graph-edge-count={edges.length}
      data-graph-selected={selected ?? ''}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${size.width} ${size.height}`}
        className="touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        role="img"
        aria-label="知识图谱画布"
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {edges.map((edge, index) => {
            const from = points[edge.source]
            const to = points[edge.target]
            if (!from || !to) return null
            const active = highlighted === null || (highlighted.has(edge.source) && highlighted.has(edge.target))
            return (
              <line
                key={`${edge.source}|${edge.target}|${index}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="currentColor"
                strokeWidth={edge.kind === 'adjacent' ? 1 : 0.8 + Math.min(2.2, edge.score * 2.2)}
                strokeOpacity={active ? (edge.kind === 'adjacent' ? 0.25 : 0.55) : 0.08}
                strokeDasharray={edge.kind === 'adjacent' ? '3 4' : undefined}
                className={edge.kind === 'semantic' ? 'text-primary' : 'text-muted-foreground'}
              />
            )
          })}

          {nodes.map((node) => {
            const point = points[node.id]
            if (!point) return null
            const radius = 8 + Math.min(11, node.degree * 1.4)
            const isSelected = selected === node.id
            const faded = dimmed(node.id)
            const tone = node.isolated
              ? 'text-muted-foreground'
              : node.kind === 'chunk'
                ? 'text-teal-600 dark:text-teal-400'
                : 'text-blue-600 dark:text-blue-400'
            return (
              <g
                key={node.id}
                data-graph-node={node.id}
                data-graph-node-kind={node.kind}
                className="cursor-pointer"
                opacity={faded ? 0.26 : 1}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect(node.id)
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  onDiscover(node.id)
                }}
              >
                {isSelected ? (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={radius + 7}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    className="text-primary"
                  />
                ) : null}
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={radius}
                  fill="currentColor"
                  fillOpacity={isSelected ? 0.42 : 0.18}
                  stroke="currentColor"
                  strokeWidth={1.2}
                  className={tone}
                />
                <text
                  x={point.x}
                  y={point.y + radius + 14}
                  textAnchor="middle"
                  fontSize={11}
                  fill="currentColor"
                  className="text-foreground"
                >
                  {node.label.length > 14 ? `${node.label.slice(0, 13)}…` : node.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-primary" />
          {nodes.length > 0 ? '相似边' : ''}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-blue-600 dark:bg-blue-400" />
          来源节点
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-teal-600 dark:bg-teal-400" />
          知识块节点
        </span>
      </div>
    </div>
  )
}
