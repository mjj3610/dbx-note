/**
 * 并排对照面板的开合逻辑
 *
 * 单独抽出来，让编辑区按钮与全局快捷键共用一份规则：
 * 已打开则关闭；未打开则优先挑一篇「不是当前笔记」的文件，避免左右互相覆盖。
 */
import { flattenFiles } from '@/lib/tree'
import { useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'

/** 返回本次操作后对照面板的路径（null 表示已关闭） */
export function toggleSidePane(): string | null {
  const ui = useUiStore.getState()
  if (ui.sidePane) {
    ui.setSidePane(null)
    return null
  }
  const notes = useNotesStore.getState()
  const other = flattenFiles(notes.tree).find((file) => file.path !== notes.activePath)
  const target = other?.path ?? notes.activePath ?? null
  if (target) ui.setSidePane(target)
  return target
}
