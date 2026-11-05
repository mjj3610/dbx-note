/**
 * 块级操作（对齐 NoteGen 块手柄菜单）
 *
 * 所有函数都按「顶层块的 ProseMirror 位置」定位，操作都走一次 transaction，
 * 因此可以撤销；越界位置直接忽略，不会抛异常。
 */
import type { Editor } from '@tiptap/react'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'

/** 块可转换成的类型（与 NoteGen 的 `EditorBlockConversionType` 一致） */
export type BlockConversionType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'

export interface BlockInfo {
  pos: number
  node: ProseNode
}

/** 由 DOM 元素反查顶层块的位置与节点 */
export function blockAt(editor: Editor, element: HTMLElement | null): BlockInfo | null {
  if (!element || editor.isDestroyed) return null
  try {
    const inside = editor.view.posAtDOM(element, 0)
    const resolved = editor.state.doc.resolve(inside)
    if (resolved.depth < 1) return null
    const pos = resolved.before(1)
    const node = editor.state.doc.nodeAt(pos)
    return node ? { pos, node } : null
  } catch {
    return null
  }
}

/** 当前块的类型（用于「转换为」里显示单选状态） */
export function conversionTypeOf(node: ProseNode): BlockConversionType {
  if (node.type.name === 'heading') return `heading${node.attrs.level}` as BlockConversionType
  if (node.type.name === 'bulletList') return 'bulletList'
  if (node.type.name === 'orderedList') return 'orderedList'
  if (node.type.name === 'taskList') return 'taskList'
  return 'paragraph'
}

/** 块内文本（用于复制内容） */
export function blockText(node: ProseNode): string {
  return node.textBetween(0, node.content.size, '\n\n')
}

/** 块序列化成 Markdown（用于复制 Markdown） */
export function blockMarkdown(editor: Editor, node: ProseNode): string {
  try {
    const storage = editor.storage as unknown as {
      markdown?: { serialize?: (content: unknown) => string }
    }
    const serialize = storage.markdown?.serialize
    if (typeof serialize === 'function') return serialize(node.toJSON())
  } catch {
    /* 序列化失败时退回纯文本 */
  }
  return blockText(node)
}

/** 光标放进块内，便于随后套用 toggle 类命令 */
function focusInside(editor: Editor, pos: number, node: ProseNode) {
  const from = pos + 1
  const to = Math.max(from, pos + node.nodeSize - 1)
  editor.chain().focus().setTextSelection({ from, to }).run()
}

/** 转换成指定块类型 */
export function convertBlock(editor: Editor, info: BlockInfo, type: BlockConversionType) {
  focusInside(editor, info.pos, info.node)
  const chain = editor.chain().focus()
  if (type === 'paragraph') {
    // 列表里转段落要走「取消列表 + 段落」
    chain.clearNodes().setParagraph().run()
    return
  }
  if (type.startsWith('heading')) {
    const level = Number(type.slice('heading'.length)) as 1 | 2 | 3 | 4 | 5 | 6
    if (info.node.type.name.endsWith('List')) chain.clearNodes()
    chain.setNodeSelection(info.pos).setHeading({ level }).run()
    return
  }
  if (info.node.type.name.endsWith('List')) chain.clearNodes()
  if (info.node.type.name === 'heading') chain.setParagraph()
  if (type === 'bulletList') chain.toggleBulletList().run()
  else if (type === 'orderedList') chain.toggleOrderedList().run()
  else chain.toggleTaskList().run()
}

/** 复制块内容（纯文本） */
export async function copyBlockContent(node: ProseNode): Promise<void> {
  await navigator.clipboard.writeText(blockText(node))
}

/** 创建副本：把当前块整段复制到它后面 */
export function duplicateBlock(editor: Editor, info: BlockInfo) {
  const { state, view } = editor
  const insertAt = info.pos + info.node.nodeSize
  const tr = state.tr.insert(insertAt, info.node.copy(info.node.content))
  view.dispatch(tr)
  view.focus()
}

/** 与相邻块交换位置 */
export function moveBlock(editor: Editor, info: BlockInfo, direction: 'up' | 'down'): boolean {
  const { state, view } = editor
  const { pos, node } = info
  if (direction === 'up') {
    if (pos <= 0) return false
    const previous = state.doc.nodeAt(pos - 1)
    if (!previous) return false
    const from = pos - previous.nodeSize
    const tr = state.tr
    tr.delete(from, pos + node.nodeSize)
    tr.insert(from, node.copy(node.content))
    tr.insert(from + node.nodeSize, previous.copy(previous.content))
    view.dispatch(tr)
    view.focus()
    return true
  }
  const after = pos + node.nodeSize
  const next = state.doc.nodeAt(after)
  if (!next) return false
  const tr = state.tr
  tr.delete(pos, after + next.nodeSize)
  tr.insert(pos, next.copy(next.content))
  tr.insert(pos + next.nodeSize, node.copy(node.content))
  view.dispatch(tr)
  view.focus()
  return true
}

/** 清除块内的行内格式与容器节点 */
export function clearBlockFormatting(editor: Editor, info: BlockInfo) {
  focusInside(editor, info.pos, info.node)
  editor.chain().focus().unsetAllMarks().clearNodes().run()
}

/** 删除整块 */
export function deleteBlock(editor: Editor, info: BlockInfo) {
  const { state, view } = editor
  const tr = state.tr.delete(info.pos, info.pos + info.node.nodeSize)
  view.dispatch(tr)
  view.focus()
}

/** 在块下方插入一个空段落并把光标放进去 */
export function addBlockBelow(editor: Editor, info: BlockInfo) {
  const { state, view } = editor
  const insertAt = info.pos + info.node.nodeSize
  const paragraph = state.schema.nodes.paragraph?.create()
  if (!paragraph) return
  const tr = state.tr.insert(insertAt, paragraph)
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)))
  view.dispatch(tr.scrollIntoView())
  view.focus()
}
