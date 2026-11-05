/**
 * 编辑器快捷键（对齐复刻项目 src/config/editor-shortcuts.ts 里的默认组合）
 *
 * 只补「TipTap 默认没有」的那些：表格组、插入组、搜索、斜杠、全部折叠。
 * 加粗 / 斜体 / 下划线 / 标题 / 列表 / 引用 / 代码块等由 TipTap 内置快捷键负责
 * （Mod+B / I / U / E、Mod+Alt+1..6、Shift+Mod+7/8/9、Shift+Mod+B、Mod+Alt+C）。
 */
import { Extension, type Editor } from '@tiptap/core'

import { openBlockMathDialog, openSearchPanel, openSlashMenu } from '@/lib/editorBus'
import { setAllHeadingsFolded } from '@/lib/headingFold'
import { mermaidTemplate } from '@/lib/mermaidNode'
import { useSettingsStore } from '@/stores/settings'

/** 当前界面是否中文（图表模板按语言给一份） */
function isZh(): boolean {
  return useSettingsStore.getState().locale.startsWith('zh')
}

/** 让编辑器先拿到焦点再执行，避免快捷键改到别处 */
function withFocus(editor: Editor, action: () => boolean): boolean {
  editor.chain().focus()
  return action()
}

export const EditorShortcuts = Extension.create({
  name: 'dbxEditorShortcuts',

  addKeyboardShortcuts() {
    const editor = this.editor

    return {
      // ---- 表格（对齐参考项目 table 组）----
      'Mod-Alt-t': () =>
        withFocus(editor, () =>
          editor.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
        ),
      'Shift-Mod-Alt-l': () => editor.can().addColumnBefore() && editor.chain().focus().addColumnBefore().run(),
      'Shift-Mod-Alt-r': () => editor.can().addColumnAfter() && editor.chain().focus().addColumnAfter().run(),
      'Shift-Mod-Alt-u': () => editor.can().addRowBefore() && editor.chain().focus().addRowBefore().run(),
      'Shift-Mod-Alt-d': () => editor.can().addRowAfter() && editor.chain().focus().addRowAfter().run(),
      'Mod-Alt-Backspace': () => editor.can().deleteColumn() && editor.chain().focus().deleteColumn().run(),
      'Shift-Mod-Alt-Backspace': () => editor.can().deleteRow() && editor.chain().focus().deleteRow().run(),
      'Mod-Alt-Delete': () => editor.can().deleteTable() && editor.chain().focus().deleteTable().run(),
      'Shift-Mod-l': () => editor.isActive('table') && editor.chain().focus().setCellAttribute('align', 'left').run(),
      'Shift-Mod-e': () =>
        editor.isActive('table') && editor.chain().focus().setCellAttribute('align', 'center').run(),
      'Shift-Mod-r': () => editor.isActive('table') && editor.chain().focus().setCellAttribute('align', 'right').run(),

      // ---- 插入（公式 / 图表 / 分隔线 / 图片占位）----
      'Mod-Alt-m': () =>
        editor.chain().focus().insertContent({ type: 'inlineMath', attrs: { latex: 'E = mc^2' } }).run(),
      'Shift-Mod-Alt-m': () => openBlockMathDialog(),
      'Mod-Alt-d': () =>
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'mermaidDiagram',
            attrs: { code: mermaidTemplate('flowchart', isZh()), type: 'flowchart' },
          })
          .run(),
      'Mod-Alt--': () => editor.chain().focus().setHorizontalRule().run(),
      'Shift-Mod-i': () =>
        editor.chain().focus().insertContent('![图片说明](assets/图片.png)').run(),

      // ---- 基础 ----
      // Mod+F 打开搜索替换：编辑器有焦点时才会命中，不干扰宿主 / 侧栏的搜索框
      'Mod-f': () => openSearchPanel(),
      'Mod-/': () => openSlashMenu(),
      // Mod+Alt+↑ / ↓ 全部折叠 / 全部展开（对齐参考项目 collapseAllHeadings / expandAllHeadings）
      'Mod-Alt-ArrowUp': () => setAllHeadingsFolded(editor, true),
      'Mod-Alt-ArrowDown': () => setAllHeadingsFolded(editor, false),
    }
  },
})
