/**
 * 文件树「更多」菜单
 *
 * 对齐参考项目 `file-more-menu.tsx` 的四组动作：
 * - 文件视图：排序（字段 + 升降序）、全部折叠、显示资源文件夹、显示知识库状态
 * - 远程文件：显示远程文件、上传静态资源、上传本地文件、下载远程文件
 * - 知识库：自动更新、全部重新计算、上传 / 下载索引快照
 * - 导入：笔记、转 Markdown、Notion (.zip)
 *
 * 0.5.6 起知识库改用真正的向量库（分块 + embedding + BM25 混合检索），
 * 「全部重新计算」重建向量，「上传 / 下载知识库」即导出 / 导入
 * 工作区 `.dbx-note/rag-snapshot.json` 向量快照。
 */
import { useState } from 'react'
import {
  Boxes,
  ChevronsUpDown,
  CloudDownload,
  CloudUpload,
  Database,
  FileDown,
  FileInput,
  FileUp,
  FolderOpen,
  HardDriveDownload,
  ListFilter,
  MoreHorizontal,
  RefreshCcwDot,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import {
  downloadRemotePaths,
  downloadKnowledgeBase,
  importLocalFiles,
  isStaticAssetPath,
  remoteOnlyPaths,
  uploadKnowledgeBase,
  type ImportMode,
} from '@/lib/fileActions'
import * as rpc from '@/lib/rpc'
import type { FileSortBy } from '@/lib/tree'

import { useT } from '@/lib/useT'
import { useKbStore } from '@/stores/kb'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'

/** 把异常转成可展示文案 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function FileMoreMenu() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const fileView = useSettingsStore((state) => state.fileView)
  const patchFileView = useSettingsStore((state) => state.patchFileView)
  const refreshKb = useKbStore((state) => state.refresh)

  const loadTree = () => useNotesStore.getState().loadTree()

  /** 执行一个会改动工作区 / 索引的动作，统一处理 busy、刷新与错误提示 */
  const run = async (action: () => Promise<void>, successKey?: string, params?: Record<string, string | number>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      if (successKey) toast.success(t(successKey, params))
    } catch (error) {
      toast.error(t('files.ctx.actionFailed', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const doImport = (mode: ImportMode) =>
    run(async () => {
      const result = await importLocalFiles('', mode, {}, fileView.syncStaticAssets)
      if (!result) return
      if (result.imported === 0) {
        toast.message(t('files.more.nothingImported'))
        return
      }
      await loadTree()
      if (result.skipped > 0) {
        toast.success(t('files.more.importSkipped', { count: result.imported, skipped: result.skipped }))
      } else {
        toast.success(t('files.more.imported', { count: result.imported }))
      }
    })

  const doDownloadRemote = () =>
    run(async () => {
      const paths = remoteOnlyPaths(useNotesStore.getState().tree).filter(
        (path) => fileView.syncStaticAssets || !isStaticAssetPath(path),
      )
      if (paths.length === 0) {
        toast.message(t('files.more.remoteEmpty'))
        return
      }
      const count = await downloadRemotePaths(paths)
      await loadTree()
      toast.success(t('files.more.remoteDone', { count }))
    })

  const doReindex = () =>
    run(async () => {
      const rag = useSettingsStore.getState().rag
      const result = await rpc.kbReindexAll({
        chunkSize: rag.chunkSize,
        chunkOverlap: rag.chunkOverlap,
        topK: rag.topK,
        threshold: rag.threshold,
      })
      await refreshKb()
      toast.success(t('files.more.reindexed', { count: result.indexed }))
      if (result.failed.length > 0) {
        toast.error(t('files.ctx.actionFailed', { message: result.failed.join('; ') }))
      }
    })

  const doUploadKb = () =>
    run(async () => {
      const result = await uploadKnowledgeBase()
      // 用户在另存为里取消：不写盘也不报成功
      if (!result.saved && !result.unsupported) return
      toast.success(t('files.more.kbExported'))
    })

  const doDownloadKb = () =>
    run(async () => {
      const count = await downloadKnowledgeBase()
      if (count === null) return
      await refreshKb()
      toast.success(t('files.more.kbImported', { count }))
    })

  const toggleKbStatus = (checked: boolean) => {
    patchFileView({ showKnowledgeBaseStatus: checked })
    if (checked) void refreshKb()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('files.more')}
          title={t('files.more')}
          data-files-more
          disabled={busy}
          onClick={() => void refreshKb()}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[80vh] w-60 overflow-y-auto" data-files-more-menu>
        {/* ---------------- 文件视图 ---------------- */}
        <DropdownMenuLabel>{t('files.more.view')}</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-files-sort>
            <ListFilter />
            {t('files.more.sort')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={fileView.sortBy}
              onValueChange={(value) => patchFileView({ sortBy: value as FileSortBy })}
            >
              <DropdownMenuRadioItem value="name" data-files-sort-by="name">
                {t('files.more.sortName')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="mtime" data-files-sort-by="mtime">
                {t('files.more.sortMtime')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="size" data-files-sort-by="size">
                {t('files.more.sortSize')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={fileView.sortOrder}
              onValueChange={(value) => patchFileView({ sortOrder: value as 'asc' | 'desc' })}
            >
              <DropdownMenuRadioItem value="asc" data-files-sort-order="asc">
                {t('files.more.sortAsc')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc" data-files-sort-order="desc">
                {t('files.more.sortDesc')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          data-files-collapse-all
          onSelect={() => {
            useNotesStore.getState().collapseAll()
            toast.success(t('files.more.collapsed'))
          }}
        >
          <ChevronsUpDown />
          {t('files.more.collapseAll')}
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          checked={fileView.showAssetsFolders}
          onCheckedChange={(checked) => patchFileView({ showAssetsFolders: Boolean(checked) })}
          data-files-show-assets
        >
          <FolderOpen />
          {t('files.more.showAssets')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={fileView.showKnowledgeBaseStatus}
          onCheckedChange={(checked) => toggleKbStatus(Boolean(checked))}
          data-files-show-kb
        >
          <Database />
          {t('files.more.showKbStatus')}
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />
        {/* ---------------- 远程文件 ---------------- */}
        <DropdownMenuLabel>{t('files.more.remote')}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={fileView.showRemoteFiles}
          onCheckedChange={(checked) => patchFileView({ showRemoteFiles: Boolean(checked) })}
          data-files-show-remote
        >
          <CloudUpload />
          {t('files.more.showRemote')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={fileView.syncStaticAssets}
          onCheckedChange={(checked) => patchFileView({ syncStaticAssets: Boolean(checked) })}
          data-files-sync-assets
        >
          <Boxes />
          {t('files.more.syncAssets')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem onSelect={() => void doImport('notes')} data-files-upload-local>
          <Upload />
          {t('files.more.uploadLocal')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void doDownloadRemote()} data-files-download-remote>
          <HardDriveDownload />
          {t('files.more.downloadRemote')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        {/* ---------------- 知识库 ---------------- */}
        <DropdownMenuLabel>{t('files.more.kb')}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={fileView.autoUpdateKnowledgeBase}
          onCheckedChange={(checked) => patchFileView({ autoUpdateKnowledgeBase: Boolean(checked) })}
          data-files-auto-kb
        >
          <RefreshCcwDot />
          {t('files.more.autoKb')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem onSelect={() => void doReindex()} data-files-reindex>
          <RefreshCcwDot />
          {t('files.more.reindexAll')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void doUploadKb()} data-files-upload-kb>
          <CloudUpload />
          {t('files.more.uploadKb')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void doDownloadKb()} data-files-download-kb>
          <CloudDownload />
          {t('files.more.downloadKb')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        {/* ---------------- 导入 ---------------- */}
        <DropdownMenuItem onSelect={() => void doImport('notes')} data-files-import-notes>
          <FileInput />
          {t('files.more.importNotes')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void doImport('markdown')} data-files-import-markdown>
          <FileDown />
          {t('files.more.importMarkdown')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void doImport('notion')} data-files-import-notion>
          <FileUp />
          {t('files.more.importNotion')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
