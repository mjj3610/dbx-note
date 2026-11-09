/**
 * 编辑器底栏「历史版本」面板（严格对齐参考项目 markdown/sync/history-sheet.tsx）
 *
 * 与参考项目一致的部分：
 * - 数据源是**远端 Git 仓库对当前笔记的提交历史**（最多 10 条），不是本地自动快照；
 * - 只在 GitHub / Gitee / GitLab / Gitea 四种 Git 托管平台、且工作区是独立 Git 仓库并
 *   配置了 origin 时显示；其它同步方式下 `return null`（参考项目 `supportsHistory`）；
 * - 每条展示短 sha（点开远端 commit 页）、提交说明、作者、时间，右侧「恢复」；
 * - 面板顶部提供「在仓库中打开」链接；
 * - 恢复按完整 sha 取该提交的正文，落盘并刷新编辑器。
 *
 * 本项目特有的三点增强：
 * - 提交历史由 Sidecar 经 `git fetch` + `git log` + `git show` 取得（工作区本身就是
 *   仓库），与参考项目调各家 REST API 拿到的是同一份历史，但离线也能看已 fetch 的记录；
 * - 恢复属于高危写操作，按项目规范增加二次确认（参考项目是直接恢复）；
 * - 宽屏用 Popover，窄屏（<=860px）用贴底的 Drawer，避免小窗里浮层被裁切。
 */
import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, History, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, Spinner } from '@/components/ui/misc'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/tooltip'
import * as rpc from '@/lib/rpc'
import type { HistoryCommit, HistoryCommitList, HistoryStatus } from '@/lib/rpc'
import { useIsNarrow } from '@/lib/useMediaQuery'
import { useT } from '@/lib/useT'
import { cn } from '@/lib/utils'
import { useNotesStore } from '@/stores/notes'

/** 把 ISO 8601 提交时间转成本地可读时间 */
function formatTime(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString()
}

/** 把未知异常转成可展示文案 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 单条提交：短 sha 外链 + 时间 + 提交说明 + 作者 + 恢复入口 */
function CommitRow({
  commit,
  busy,
  onRestore,
}: {
  commit: HistoryCommit
  busy: boolean
  onRestore: (commit: HistoryCommit) => void
}) {
  const t = useT()
  return (
    <li data-history-commit className="rounded-lg border border-border px-2.5 py-2 hover:bg-muted/50">
      <div className="flex items-center justify-between gap-2">
        <a
          href={commit.url}
          target="_blank"
          rel="noopener noreferrer"
          title={t('footer.history.openCommit')}
          className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-primary"
          data-history-commit-link
        >
          {commit.shortSha}
          <ExternalLink className="size-2.5" />
        </a>
        <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(commit.date)}</span>
      </div>
      <p className="mt-1 truncate text-[12px]" title={commit.message}>
        {commit.message || t('footer.history.noMessage')}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">{commit.author}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          data-history-restore
          onClick={() => onRestore(commit)}
          title={t('footer.history.restore')}
        >
          <RotateCcw className="size-3" />
          {busy ? t('footer.history.restoring') : t('footer.history.restore')}
        </Button>
      </div>
    </li>
  )
}

/** 面板正文：宽屏 Popover 与窄屏 Drawer 共用同一份内容 */
function HistoryPanel({
  title,
  fileUrl,
  fileName,
  loading,
  commits,
  reason,
  restoring,
  onRestore,
}: {
  title: string
  fileUrl: string
  fileName: string
  loading: boolean
  commits: HistoryCommit[]
  reason?: string
  restoring: string | null
  onRestore: (commit: HistoryCommit) => void
}) {
  const t = useT()
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">{title}</span>
        {fileUrl ? (
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={t('footer.history.openInRepo')}
            data-history-open-repo
            className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
          >
            <ExternalLink className="size-2.5 shrink-0" />
            <span className="max-w-32 truncate">{fileName}</span>
          </a>
        ) : null}
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto" data-history-list>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            {t('footer.history.loading')}
          </div>
        ) : commits.length === 0 ? (
          <p className="py-8 text-center text-[11px] text-muted-foreground">
            {reason || t('footer.history.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {commits.map((commit) => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                busy={restoring === commit.sha}
                onRestore={onRestore}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

/** 历史版本入口 + 提交列表面板 + 恢复二次确认 */
export function HistorySheet({ path }: { path: string }) {
  const t = useT()
  const narrow = useIsNarrow()
  const [status, setStatus] = useState<HistoryStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<HistoryCommitList | null>(null)
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [pendingRestore, setPendingRestore] = useState<HistoryCommit | null>(null)

  /** 入口是否可用由后端判定；切换笔记或同步配置后重新判定 */
  const refreshStatus = useCallback(() => {
    void rpc
      .historyStatus()
      .then(setStatus)
      .catch((error) => setStatus({ supported: false, reason: errorMessage(error) }))
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [path, refreshStatus])

  // 用户在设置页改完同步平台、或窗口回到前台时立即反映，不必重载页面
  useEffect(() => {
    const refresh = () => refreshStatus()
    window.addEventListener('focus', refresh)
    window.addEventListener('dbx:sync-options-changed', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('dbx:sync-options-changed', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [refreshStatus])

  const loadHistory = useCallback(async () => {
    setLoading(true)
    try {
      setList(await rpc.historyCommits(path))
    } catch (error) {
      toast.error(t('footer.history.loadFailed', { message: errorMessage(error) }))
      setList({ supported: false, commits: [] })
    } finally {
      setLoading(false)
    }
  }, [path, t])

  // 面板每次打开重新拉列表（参考项目 `useEffect([isOpen, activeFilePath])`）
  useEffect(() => {
    if (open && path && status?.supported) void loadHistory()
  }, [open, path, status?.supported, loadHistory])

  /** 窄屏先收起抽屉再弹确认框，避免两个 modal 同时抢焦点 */
  const beginRestore = (commit: HistoryCommit) => {
    if (narrow) setOpen(false)
    setPendingRestore(commit)
  }

  const restore = async () => {
    const target = pendingRestore
    if (!target || restoring) return
    setRestoring(target.sha)
    try {
      const version = await rpc.historyContent(path, target.sha)
      // 先把编辑器里尚未落盘的改动写盘，避免恢复后被 800ms 防抖保存覆盖回去
      await useNotesStore.getState().save({ force: true })
      await rpc.writeFile(path, version.content)
      await useNotesStore.getState().reloadActive({ force: true })
      toast.success(t('footer.history.restored'))
      setPendingRestore(null)
      setOpen(false)
      await loadHistory()
    } catch (error) {
      toast.error(t('footer.history.restoreFailed', { message: errorMessage(error) }))
    } finally {
      setRestoring(null)
    }
  }

  // 与参考项目 supportsHistory 一致：不支持的平台 / 未配置远端时不渲染入口
  if (!status?.supported) return null

  const commits = list?.commits ?? []
  const panel = (
    <HistoryPanel
      title={t('footer.history.title')}
      fileUrl={list?.fileUrl ?? ''}
      fileName={path.split(/[\\/]/).pop() || path}
      loading={loading}
      commits={commits}
      reason={list?.reason}
      restoring={restoring}
      onRestore={beginRestore}
    />
  )

  // 窄屏由按钮自己打开 Dialog；宽屏交给 PopoverTrigger（asChild 会合并 onClick，不能两边都写）
  const trigger = (
    <button
      type="button"
      data-footer-history
      title={t('footer.history')}
      className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      {...(narrow ? { onClick: () => setOpen(true) } : {})}
    >
      <History className="size-3" />
      {t('footer.history')}
    </button>
  )

  return (
    <>
      {narrow ? (
        <>
          {trigger}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              aria-describedby={undefined}
              className={cn(
                'inset-x-0 right-0 bottom-0 left-0 top-auto w-full max-w-none translate-x-0 translate-y-0',
                'flex max-h-[80vh] flex-col gap-0 rounded-none rounded-t-2xl p-3',
              )}
            >
              <DialogTitle className="sr-only">{t('footer.history.title')}</DialogTitle>
              {panel}
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            className="flex max-h-100 w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden p-3"
          >
            {panel}
          </PopoverContent>
        </Popover>
      )}

      <ConfirmDialog
        open={pendingRestore !== null}
        title={t('footer.history.restoreTitle')}
        description={t('footer.history.restoreDesc', {
          time: pendingRestore ? formatTime(pendingRestore.date) : '',
        })}
        confirmLabel={t('footer.history.confirm')}
        cancelLabel={t('footer.history.cancel')}
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => void restore()}
      />
    </>
  )
}
