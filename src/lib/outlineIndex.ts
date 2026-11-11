import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { Mapping, type Step } from '@tiptap/pm/transform'

/**
 * 大纲标题索引
 *
 * 对齐参考项目 NoteGen `markdown/outline-index.ts`：直接从 ProseMirror doc 建索引，
 * 每条标题带稳定的 `id` 与文档位置 `pos`，并用 Mapping 只重扫变更区间。
 *
 * 之前大纲从 `content`（Markdown 文本）全量 split + 正则解析，再把标题「文本」
 * 传给编辑器做精确匹配：既每次按键都要 O(n) 重解析，又会因为 inline 语法
 * （**粗体**、$公式$、[链接]()）导致「正文文本 ≠ Markdown 源文本」而匹配失败，
 * 表现就是只有纯文本的一级标题能定位。
 */
export interface HeadingItem {
  level: number
  /** 未去语法的原文（用于比较与实际编辑） */
  rawText: string
  /** 面板显示文案；空标题用兜底文案 */
  text: string
  /** 稳定标识：大纲点击只传 id，不再传标题文本 */
  id: string
  /** ProseMirror 文档位置；Markdown 兜底（源码模式）为 -1 */
  pos: number
  nodeSize: number
  /** Markdown 兜底（源码模式）下的行号，用于 CodeMirror 跳转 */
  line?: number
}

interface ChangedRange {
  from: number
  to: number
}

export type UntitledHeading = (level: number) => string

export class OutlineHeadingIndex {
  private doc: ProseMirrorNode | null = null
  private headings: HeadingItem[] = []
  private headingIds = new WeakMap<ProseMirrorNode, string>()
  private nextHeadingId = 0

  private readHeadings(
    doc: ProseMirrorNode,
    ranges: ChangedRange[],
    untitledHeading: UntitledHeading,
    mappedIds = new Map<number, string>(),
    usedIds = new Set<string>(),
  ) {
    const headings = new Map<number, HeadingItem>()

    for (const { from, to } of ranges) {
      doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== 'heading') return !node.isTextblock
        if (headings.has(pos)) return false

        const rawLevel = node.attrs.level
        const level = typeof rawLevel === 'number' ? rawLevel : Number(rawLevel) || 1
        const rawText = node.textContent.trim()
        let id = mappedIds.get(pos) ?? this.headingIds.get(node)

        if (!id || usedIds.has(id)) {
          id = `heading-${this.nextHeadingId}`
          this.nextHeadingId += 1
        }

        this.headingIds.set(node, id)
        usedIds.add(id)
        headings.set(pos, {
          level,
          rawText,
          text: rawText || untitledHeading(level),
          id,
          pos,
          nodeSize: node.nodeSize,
        })

        // 标题内联节点里不可能再有标题，读到标题即可停止下钻
        return false
      })
    }

    return [...headings.values()]
  }

  rebuild(doc: ProseMirrorNode, untitledHeading: UntitledHeading) {
    const mappedIds = this.doc === doc
      ? new Map(this.headings.map((heading) => [heading.pos, heading.id]))
      : new Map<number, string>()
    this.doc = doc
    this.headings = this.readHeadings(
      doc,
      [{ from: 0, to: doc.content.size }],
      untitledHeading,
      mappedIds,
    )
    return this.headings
  }

  update(doc: ProseMirrorNode, transactions: Transaction[], untitledHeading: UntitledHeading) {
    if (this.doc === doc) return this.headings

    // 大纲未订阅期间发生的变更无法增量映射，直接重建
    if (transactions[0]?.before !== this.doc || transactions.at(-1)?.doc !== doc) {
      return this.rebuild(doc, untitledHeading)
    }

    const mapping = new Mapping()
    const steps: Step[] = []

    for (const transaction of transactions) {
      mapping.appendMapping(transaction.mapping)
      steps.push(...transaction.steps)
    }

    const ranges: ChangedRange[] = []
    let hasUnknownStep = false

    mapping.maps.forEach((stepMap, index) => {
      const remainingMapping = mapping.slice(index + 1)
      const addRange = (from: number, to: number) => {
        ranges.push({
          from: Math.max(0, remainingMapping.map(from, -1) - 1),
          to: Math.min(doc.content.size, remainingMapping.map(to, 1) + 1),
        })
      }
      let hasMappedRange = false

      stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
        hasMappedRange = true
        addRange(newFrom, newTo)
      })

      if (hasMappedRange) return

      // mark 与节点属性变更不改变位置，但仍要重扫对应区间
      const step = steps[index] as Step & { from?: number; to?: number; pos?: number }
      if (typeof step.from === 'number' && typeof step.to === 'number') {
        addRange(step.from, step.to)
      } else if (typeof step.pos === 'number') {
        addRange(step.pos, step.pos + 1)
      } else if ((step.toJSON() as { stepType?: string })?.stepType !== 'docAttr') {
        hasUnknownStep = true
      }
    })

    if (hasUnknownStep) return this.rebuild(doc, untitledHeading)

    ranges.sort((a, b) => a.from - b.from)
    const mergedRanges: ChangedRange[] = []
    for (const range of ranges) {
      const previous = mergedRanges.at(-1)
      if (previous && range.from <= previous.to) {
        previous.to = Math.max(previous.to, range.to)
      } else {
        mergedRanges.push({ ...range })
      }
    }

    const mappedIds = new Map<number, string>()
    const unchangedHeadings: HeadingItem[] = []
    const usedIds = new Set<string>()

    for (const heading of this.headings) {
      const mapped = mapping.mapResult(heading.pos, 1)
      // setNodeMarkup 只换开标签、保留内容：层级变化要沿用 id，整段删除才丢弃
      if (mapped.deleted && mapping.mapResult(heading.pos + 1, 1).deleted) continue

      const end = mapping.map(heading.pos + heading.nodeSize, -1)
      mappedIds.set(mapped.pos, heading.id)

      if (mergedRanges.some((range) => mapped.pos < range.to && end > range.from)) continue

      unchangedHeadings.push(
        mapped.pos === heading.pos && end - mapped.pos === heading.nodeSize
          ? heading
          : { ...heading, pos: mapped.pos, nodeSize: end - mapped.pos },
      )
      usedIds.add(heading.id)
    }

    const changedHeadings = this.readHeadings(doc, mergedRanges, untitledHeading, mappedIds, usedIds)
    this.doc = doc
    this.headings = [...unchangedHeadings, ...changedHeadings].sort((a, b) => a.pos - b.pos)
    return this.headings
  }
}

/**
 * 源码模式 / 编辑器尚未挂载时的兜底大纲：直接从 Markdown 文本解析。
 * 此时没有 ProseMirror 位置，点击按 `line` 跳到 CodeMirror 对应行。
 */
export function headingsFromMarkdown(markdown: string, untitledHeading: UntitledHeading): HeadingItem[] {
  const items: HeadingItem[] = []
  let inFence = false
  markdown.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!match) return
    const level = match[1].length
    const rawText = match[2].trim()
    items.push({
      level,
      rawText,
      text: rawText || untitledHeading(level),
      id: `md-${index}`,
      pos: -1,
      nodeSize: 0,
      line: index,
    })
  })
  return items
}
