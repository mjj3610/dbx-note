import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/ui/misc'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'

/**
 * 删除确认：文件 / 文件夹从磁盘移除属于高危操作，必须二次确认
 */
export function DeleteConfirmDialog() {
  const t = useT()
  const target = useUiStore((state) => state.deleteTarget)
  const cancel = useUiStore((state) => state.cancelDelete)
  const remove = useNotesStore((state) => state.remove)
  const tree = useNotesStore((state) => state.tree)

  const name = target?.split('/').pop() ?? ''
  const isFolder = target ? isFolderPath(tree, target) : false

  return (
    <ConfirmDialog
      open={Boolean(target)}
      title={t('files.deleteTitle', { name })}
      description={isFolder ? t('files.deleteFolderDesc') : t('files.deleteDesc')}
      confirmLabel={t('common.delete')}
      cancelLabel={t('common.cancel')}
      onCancel={cancel}
      onConfirm={() => {
        if (!target) return
        const path = target
        cancel()
        void remove(path)
          .then(() => toast.success(t('files.deleted')))
          .catch((error) =>
            toast.error(t('toast.error', { message: error instanceof Error ? error.message : String(error) })),
          )
      }}
    />
  )
}

/** 在树中查找路径是否为文件夹 */
function isFolderPath(nodes: ReturnType<typeof useNotesStore.getState>['tree'], path: string): boolean {
  for (const node of nodes) {
    if (node.path === path) return node.kind === 'folder'
    if (node.kind === 'folder' && path.startsWith(`${node.path}/`)) {
      return isFolderPath(node.children ?? [], path)
    }
  }
  return false
}
