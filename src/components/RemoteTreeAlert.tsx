/**
 * 云端文件清单拉取失败状态条
 *
 * 对齐参考项目 `unified-sync-status.tsx`：目录同步失败时把原因常驻显示出来，
 * 并提供带 retrying 态的重试入口。参考项目按目录记录 `failedDirectories`，
 * 本项目后端一次 `git fetch` 拿全量清单，因此只对应一个整体失败态。
 *
 * 为什么必须有它：清单只拉元信息，失败时如果用户不点开任何云端文件，
 * 界面上唯一的现象就是「远端新文件一直不出现」，没有任何报错。
 */
import { useState } from 'react'
import { AlertCircle, Loader2, RefreshCw, Settings2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'

/** 把任意异常转成可展示文案 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function RemoteTreeAlert() {
  const t = useT()
  const failure = useNotesStore((state) => state.remoteTreeFailure)
  const remoteSyncing = useNotesStore((state) => state.remoteSyncing)
  const retryRemoteTree = useNotesStore((state) => state.retryRemoteTree)
  const openSettings = useUiStore((state) => state.openSettings)
  const [retrying, setRetrying] = useState(false)

  if (!failure) return null

  const busy = retrying || remoteSyncing

  /**
   * 重试一次云端清单拉取
   *
   * @returns 无返回值；成功 / 失败通过 toast 与状态条自身的变化反馈
   */
  const runRetry = async (): Promise<void> => {
    if (busy) return
    setRetrying(true)
    try {
      const recovered = await retryRemoteTree()
      if (recovered) {
        toast.success(t('sync.remoteTree.retryOk'))
        return
      }
      const latest = useNotesStore.getState().remoteTreeFailure
      toast.warning(
        t('sync.remoteTree.retryFailed', {
          message: latest?.message || t('sync.remoteTree.unknown'),
        }),
      )
    } catch (error) {
      toast.error(t('sync.remoteTree.retryFailed', { message: errorMessage(error) }))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-2.5 py-2"
      data-remote-tree-alert="1"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-destructive">
            {t('sync.remoteTree.failTitle')}
            {failure.provider ? (
              <span className="rounded bg-destructive/15 px-1 text-[10px]">{failure.provider}</span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('sync.remoteTree.failHint')}</p>
          {failure.message ? (
            <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-all font-sans text-[11px] text-destructive/90">
              {failure.message}
            </pre>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void runRetry()}
              data-remote-tree-retry="1"
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {retrying ? t('sync.remoteTree.retrying') : t('sync.remoteTree.retry')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => openSettings('sync')}
              data-remote-tree-settings="1"
            >
              <Settings2 className="size-3" />
              {t('sync.remoteTree.openSettings')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
