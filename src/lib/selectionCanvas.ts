/**
 * 从选中文字生成画布
 *
 * 参考实现是把选区交给 Agent 生成结构化结果；插件里没有常驻 Agent，
 * 这里用确定性的排版规则生成（不依赖模型、离线可用、结果可预期）：
 *
 * - 流程图：逐条成为流程节点，首条做成「开始/结束」外观，按顺序连线
 * - 思维导图：首条居中，其余分左右两列放射，各自连回中心
 * - 时间线：识别日期 / 季度 / 第 N 天这类前缀，竖直串联
 * - 任务关系：识别 `- [ ]` / `- [x]` / 列表项，落成待办卡片
 */
import type { CanvasEdge, CanvasNode } from '@/stores/canvas'
import { shapeDefaultSize } from '@/lib/canvasShapes'
import { localId } from '@/lib/utils'

export type CanvasFromSelectionKind = 'flowchart' | 'mindmap' | 'timeline' | 'tasks'

/** 一个节点最多容纳的文本长度，太长会撑爆卡片 */
const MAX_TEXT = 140
/** 最多生成多少个节点，避免选一整篇长文时生成几百个卡片 */
const MAX_ITEMS = 12

const CARD_W = 208
const CARD_H = 76

/** 去掉 Markdown 标记，抽出「有内容的一行」 */
function cleanLine(raw: string): { text: string; checked: boolean | null } | null {
  let line = raw.replace(/\r$/, '')
  let checked: boolean | null = null

  const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/)
  if (task) {
    checked = task[1].toLowerCase() === 'x'
    line = task[2]
  } else {
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/^\s*>\s?/, '')
  }

  line = line
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .trim()

  if (!line || /^[-*_=]{3,}$/.test(line)) return null
  return { text: line.slice(0, MAX_TEXT), checked }
}

interface ParsedLine {
  text: string
  checked: boolean | null
}

function parseLines(text: string): ParsedLine[] {
  const items: ParsedLine[] = []
  for (const raw of text.split('\n')) {
    const cleaned = cleanLine(raw)
    if (!cleaned) continue
    items.push(cleaned)
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

const DATE_PREFIX =
  /^((?:\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)|\d{1,2}月\d{0,2}日?|Q[1-4]|第[一二三四五六七八九十\d]+[天周月年]|Day\s*\d+|Week\s*\d+)[：:、·\-\s]+(.+)$/i

function splitDate(text: string): { date: string; rest: string } | null {
  const matched = text.match(DATE_PREFIX)
  if (!matched) return null
  return { date: matched[1].trim(), rest: matched[2].trim() }
}

function card(id: string, x: number, y: number, text: string, tone?: CanvasNode['tone']): CanvasNode {
  return { id, x, y, text, kind: 'card', w: CARD_W, h: CARD_H, ...(tone ? { tone } : {}) }
}

function shape(
  id: string,
  x: number,
  y: number,
  text: string,
  type: CanvasNode['shape'],
): CanvasNode {
  const size = shapeDefaultSize(type ?? 'process')
  return { id, x, y, text, kind: 'shape', shape: type, w: size.w, h: size.h }
}

function chain(nodes: CanvasNode[]): CanvasEdge[] {
  const edges: CanvasEdge[] = []
  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push({ id: localId(), from: nodes[index].id, to: nodes[index + 1].id })
  }
  return edges
}

/** 由选区文本与类型生成一份画布文档内容（不含 version/updatedAt，由 store 补齐） */
export function buildCanvasFromText(
  text: string,
  kind: CanvasFromSelectionKind,
  fallbackTitle: string,
): { title: string; nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const built = layoutCanvas(text, kind, fallbackTitle)
  // 画布打开时视图停在原点，左上角又被浮动工具条压着：
  // 整体右移 / 下移一点，保证生成后第一眼就能看到内容
  return {
    ...built,
    nodes: built.nodes.map((node) => ({ ...node, x: node.x + 56, y: node.y + 40 })),
  }
}

function layoutCanvas(
  text: string,
  kind: CanvasFromSelectionKind,
  fallbackTitle: string,
): { title: string; nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const items = parseLines(text)
  const title = (items[0]?.text ?? fallbackTitle).slice(0, 24) || fallbackTitle

  if (items.length === 0) {
    return { title, nodes: [], edges: [] }
  }

  if (kind === 'flowchart') {
    const nodes = items.map((item, index) =>
      shape(
        localId(),
        index * (shapeDefaultSize('process').w + 64),
        0,
        item.text,
        index === 0 ? 'terminator' : 'process',
      ),
    )
    return { title, nodes, edges: chain(nodes) }
  }

  if (kind === 'mindmap') {
    const center = shape(localId(), 0, 0, title, 'terminator')
    const centerSize = shapeDefaultSize('terminator')
    const branches = items.slice(items.length > 1 ? 1 : 0)
    const left: CanvasNode[] = []
    const right: CanvasNode[] = []
    branches.forEach((item, index) => {
      const column = index % 2 === 0 ? right : left
      const row = Math.floor(index / 2)
      const node = card(
        localId(),
        index % 2 === 0
          ? centerSize.w + 80
          : -(CARD_W + 80),
        row * (CARD_H + 28) - ((Math.ceil(branches.length / 2) - 1) * (CARD_H + 28)) / 2,
        item.text,
      )
      column.push(node)
    })
    const nodes = [center, ...right, ...left]
    const edges = [...right, ...left].map((node) => ({
      id: localId(),
      from: center.id,
      to: node.id,
    }))
    return { title, nodes, edges }
  }

  if (kind === 'timeline') {
    const nodes = items.map((item, index) => {
      const parsed = splitDate(item.text)
      const label = parsed ? `${parsed.date} · ${parsed.rest}` : `${index + 1}. ${item.text}`
      return card(localId(), 0, index * (CARD_H + 36), label)
    })
    return { title, nodes, edges: chain(nodes) }
  }

  // tasks：勾选态直接映射到卡片语义色
  const nodes = items.map((item, index) =>
    card(
      localId(),
      0,
      index * (CARD_H + 20),
      item.text,
      item.checked === true ? 'done' : item.checked === false ? 'todo' : 'default',
    ),
  )
  return { title, nodes, edges: [] }
}
