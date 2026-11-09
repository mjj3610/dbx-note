/**
 * 编辑器底栏「历史版本」面板
 *
 * 与参考项目 `sync/history-sheet.tsx` 的语义一致：列出该笔记的历史版本、可预览、可恢复。
 * 差别在数据源：参考项目读远端 GitHub / Gitee / GitLab 的 commit 列表，本项目读 Sidecar
 * 本地 `file_history` 表（保存时留档），因此不配置云同步也能用，恢复也不需要联网。
 *
 * 恢复属于高危操作：先二次确认，再把当前内容强制留档、写回历史正文、刷新编辑器。
 */
import { useCallback, useEffect, useState } from 'react'
import { History, Loader2, Plus, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, Spinner } from '@/components/ui/misc'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/tooltip'
import * as rpc from '@/lib/rpc'
import type { HistoryItem, HistoryVersion } from '@/lib/rpc'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'

/** 面板一次最多展示的版本数（后端单文件最多保留 50 条） */
const HISTORY_LIST_LIMIT = 20

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 毫秒时间戳 → 本地可读时间 */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

/** 单条历史版本：时间、字符数、摘要、预览 / 恢复入口 */
function HistoryRow({
  item,
  busy,
  onPreview,
  onRestore,
}: {
  item: HistoryItem
  busy: boolean
  onPreview: (item: HistoryItem) => void
  onRestore: (item: HistoryItem) => void
}) {
  const t = useT()
  return (
    <li data-history-item className="rounded-lg border border-border px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{formatTime(item.createdAt)}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t('footer.history.size', { count: item.size })}
        </span>
      </div>
      <p className="mt-1 truncate text-[12px]" title={item.preview}>
        {item.preview || '—'}
      </p>
      <div className="mt-1.5 flex justify-end gap-1">
        <Button size="sm" variant="ghost" disabled={busy} data-history-preview onClick={() => onPreview(item)}>
          {t('footer.history.preview')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} data-history-restore onClick={() => onRestore(item)}>
          <RotateCcw className="size-3" />
          {t('footer.history.restore')}
        </Button>
      </div>
    </li>
  )
}

/** 历史版本入口 + 面板 + 预览 / 二次确认弹窗 */
export function HistoryMenu({ path, markdown }: { path: string; markdown: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<HistoryVersion | null>(null)
  const [pendingRestore, setPendingRestore] = useState<HistoryItem | null>(null)

  const loadHistory = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await rpc.historyList(path, HISTORY_LIST_LIMIT)
      setItems(result.items)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [path])

  // 面板每次打开、或切换笔记时重新拉列表；恢复 / 创建后由调用方主动刷新
  useEffect(() => {
    if (open && path) void loadHistory()
  }, [open, path, loadHistory])

  const createVersion = async () => {
    setBusy(true)
    try {
      const result = await rpc.historyCreate(path, markdown)
      if (result.created) toast.success(t('footer.history.created'))
      else toast.message(t('footer.history.unchanged'))
      await loadHistory()
    } catch (error) {
      toast.error(t('footer.history.createFailed', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const openPreview = async (item: HistoryItem) => {
    setBusy(true)
    try {
      setPreview(await rpc.historyGet(item.id))
      setOpen(false)
    } catch (error) {
      toast.error(t('footer.history.loadFailed', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    const target = pendingRestore
    if (!target || busy) return
    setBusy(true)
    try {
      // 1. 当前内容强制留档：自动快照有 1 分钟节流，不能靠它兜底
      await rpc.historyCreate(path, useNotesStore.getState().content)
      // 2. 把编辑器里尚未落盘的改动先写盘，避免恢复后被防抖保存覆盖回去
      await useNotesStore.getState().save({ force: true })
      // 3. 取历史正文写回文件，并强制重载编辑器
      const version = await rpc.historyGet(target.id)
      await rpc.writeFile(path, version.content)
      await useNotesStore.getState().reloadActive({ force: true })
      // 4. 恢复本身也记一个版本，历史时间线保持连续
      await rpc.historyCreate(path, version.content)
      toast.success(t('footer.history.restored'))
      setPendingRestore(null)
      setPreview(null)
      await loadHistory()
    } catch (error) {
      toast.error(t('footer.history.restoreFailed', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-footer-history
            title={t('footer.history')}
            className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <History className="size-3" />
            {t('footer.history')}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-96 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold">{t('footer.history.title')}</span>
            <Button size="sm" variant="outline" disabled={busy} data-history-create onClick={() => void createVersion()}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              {t('footer.history.create')}
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t('footer.history.autoHint')}
          </p>

          <div className="mt-2 max-h-72 overflow-y-auto" data-history-list>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-muted-foreground">
                <Spinner className="size-3" />
                {t('footer.history.loading')}
              </div>
            ) : loadError ? (
              <p className="py-6 text-center text-[11px] text-destructive">
                {t('footer.history.loadFailed', { message: loadError })}
              </p>
            ) : items.length === 0 ? (
              <p className="py-6 text-center text-[11px] text-muted-foreground">
                {t('footer.history.empty')}
              </p>
            ) : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <HistoryRow
                    key={item.id}
                    item={item}
                    busy={busy}
                    onPreview={(target) => void openPreview(target)}
                    onRestore={(target) => {
                      setPendingRestore(target)
                      setOpen(false)
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={preview !== null} onOpenChange={(next) => (!next ? setPreview(null) : undefined)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('footer.history.previewTitle')}</DialogTitle>
            <DialogDescription>
              {preview ? `${formatTime(preview.createdAt)} · ${t('footer.history.size', { count: preview.content.length })}` : ''}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[55vh] overflow-auto rounded-lg bg-muted/50 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">
            {preview?.content ?? ''}
          </pre>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setPreview(null)}>
              {t('footer.history.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy || !preview}
              onClick={() => {
                if (preview) setPendingRestore({ ...preview, preview: '', size: preview.content.length })
                setPreview(null)
              }}
            >
              <RotateCcw className="size-3.5" />
              {t('footer.history.restore')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingRestore !== null}
        title={t('footer.history.restoreTitle')}
        description={t('footer.history.restoreDesc', {
          time: pendingRestore ? formatTime(pendingRestore.createdAt) : '',
        })}
        confirmLabel={t('footer.history.confirm')}
        cancelLabel={t('footer.history.cancel')}
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => void restore()}
      />
    </>
  )
}
