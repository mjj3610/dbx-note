/**
 * 表格单元格扩展：补 `align` 属性
 *
 * 官方 TableCell / TableHeader 只有合并相关的属性，做不了「列对齐」。
 * 这里按参考实现的做法加一个 `align`，落成 `data-align`，
 * 刷新或粘贴回来仍能读出来；GFM 表格本身表达不了对齐，序列化成 Markdown 时丢弃。
 */
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'

function alignAttribute() {
  return {
    align: {
      default: null as string | null,
      parseHTML: (element: HTMLElement) => {
        const value = element.getAttribute('data-align') ?? element.style.textAlign
        return value === 'left' || value === 'center' || value === 'right' ? value : null
      },
      renderHTML: (attributes: Record<string, unknown>) => {
        const value = attributes.align
        return value === 'left' || value === 'center' || value === 'right'
          ? { 'data-align': value as string }
          : {}
      },
    },
  }
}

/** 支持列对齐的数据单元格 */
export const DbxTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute() }
  },
})

/** 支持列对齐的表头单元格 */
export const DbxTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute() }
  },
})
