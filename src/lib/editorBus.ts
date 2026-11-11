/**
 * 编辑器桥：让非编辑器组件（AI 面板、大纲）能操作当前编辑器实例
 *
 * Tiptap 实例在 MarkdownEditor 内部创建，这里只暴露最小能力集合，
 * 避免把 editor 放进全局 store 造成不必要的重渲染。
 */
type InsertHandler = (markdown: string, mode: 'append' | 'replace') => void
/**
 * 按标题 id 定位（参考项目同款语义）。
 * 返回 false 表示当前没有可用的可视化编辑器（例如源码模式），由调用方降级到行号跳转。
 */
type ScrollHandler = (headingId: string) => boolean
type SlashHandler = () => void
type MathDialogHandler = () => void
type SearchHandler = () => void

export const editorBus: {
  insert: InsertHandler | null
  scrollToHeading: ScrollHandler | null
  openSlash: SlashHandler | null
  /** 打开「插入块级公式」弹窗（斜杠命令 math.block 用） */
  openMathDialog: MathDialogHandler | null
  /** 打开编辑器内搜索替换面板（Ctrl/⌘+F） */
  openSearch: SearchHandler | null
} = {
  insert: null,
  scrollToHeading: null,
  openSlash: null,
  openMathDialog: null,
  openSearch: null,
}

/** 打开块级公式弹窗（无编辑器时返回 false） */
export function openBlockMathDialog(): boolean {
  if (!editorBus.openMathDialog) return false
  editorBus.openMathDialog()
  return true
}

/** 追加 Markdown 到当前笔记末尾（无编辑器时返回 false） */
export function insertToEditor(markdown: string): boolean {
  if (!editorBus.insert) return false
  editorBus.insert(markdown, 'append')
  return true
}

/** 跳转到指定标题（id 来自大纲索引，而非标题文本） */
export function scrollToHeading(id: string): boolean {
  if (!editorBus.scrollToHeading) return false
  return editorBus.scrollToHeading(id)
}

/** 在光标处起一行并输入 `/`，唤起斜杠命令面板 */
export function openSlashMenu(): boolean {
  if (!editorBus.openSlash) return false
  editorBus.openSlash()
  return true
}

/** 打开编辑器内搜索替换面板（无编辑器时返回 false） */
export function openSearchPanel(): boolean {
  if (!editorBus.openSearch) return false
  editorBus.openSearch()
  return true
}
