/**
 * 同步冲突弹窗
 *
 * 与 NoteGen 的 `conflict-dialog` 对齐：本地和远端都改过同一个文件时，
 * 左右并排给出两边内容，由用户决定保留哪一边。
 *
 * - 采用远端：把远端内容写回本地并推进同步基线；
 * - 保留本地：清掉该文件的基线，下次提交推送会覆盖远端。
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { syncResolveConflict } from '@/lib/rpc'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'

export function SyncConflictDialog() {
  const t = useT()
  const conflict = useUiStore((state) => state.syncConflict)
  const close = useUiStore((state) => state.closeSyncConflict)
  const reloadActive = useNotesStore((state) => state.reloadActive)
  const [busy, setBusy] = useState<'local' | 'remote' | ''>('')

  // 关闭后重置按钮状态，避免下次打开还显示加载中
  useEffect(() => {
    if (!conflict) setBusy('')
  }, [conflict])

  const resolve = async (side: 'local' | 'remote') => {
    if (!conflict) return
    setBusy(side)
    try {
      await syncResolveConflict(conflict.path, side)
      if (side === 'remote') {
        // 远端内容已经写到磁盘，重新读一次让编辑器跟上
        await reloadActive({ force: true })
      }
      toast.success(side === 'remote' ? t('sync.conflict.keptRemote') : t('sync.conflict.keptLocal'))
      close()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const pane = (title: string, body: string) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-border">
      <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        {title}
      </div>
      <pre className="min-h-[9rem] flex-1 overflow-auto p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {body || t('sync.conflict.emptyContent')}
      </pre>
    </div>
  )

  return (
    <Dialog open={conflict !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="max-w-3xl" data-sync-conflict>
        <DialogHeader>
          <DialogTitle>{t('sync.conflict.title')}</DialogTitle>
          <DialogDescription>
            {t('sync.conflict.description')}
            {conflict ? <span className="ml-1 font-mono text-[11px]">{conflict.path}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 gap-3">
          {pane(t('sync.conflict.local'), conflict?.local ?? '')}
          {pane(t('sync.conflict.remote'), conflict?.remote ?? '')}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== ''}
            onClick={() => void resolve('local')}
            data-conflict-keep-local
          >
            {busy === 'local' ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('sync.conflict.keepLocal')}
          </Button>
          <Button size="sm" disabled={busy !== ''} onClick={() => void resolve('remote')} data-conflict-keep-remote>
            {busy === 'remote' ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('sync.conflict.keepRemote')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
