import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  Cloud,
  CloudDownload,
  CloudUpload,
  Copy,
  Database,
  ExternalLink,
  FilePlus2,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDriveDownload,
  Image as ImageIcon,
  LayoutTemplate,
  Pencil,
  RefreshCcwDot,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'

import { EmptyState } from '@/components/ui/misc'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { Button } from '@/components/ui/button'
import { pullRemoteFileOnDemand } from '@/lib/autoSync'
import {
  createFromTemplate,
  downloadRemotePaths,
  duplicateEntry,
  importLocalFiles,
  isStaticAssetPath,
  pasteClipboard,
  remoteOnlyPaths,
  revealEntry,
  targetDirOf,
} from '@/lib/fileActions'
import * as rpc from '@/lib/rpc'
import type { TemplateItem, TreeNode } from '@/lib/rpc'
import { findTreeNode } from '@/lib/tree'
import { cn, dirName } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useKbStore } from '@/stores/kb'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

interface FileTreeProps {
  nodes: TreeNode[]
  keyword: string
}

/** 把异常转成可展示文案 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 统一执行动作并给出失败提示 */
async function runAction(t: ReturnType<typeof useT>, action: () => Promise<void>, successKey?: string) {
  try {
    await action()
    if (successKey) toast.success(t(successKey))
  } catch (error) {
    toast.error(t('files.ctx.actionFailed', { message: errorMessage(error) }))
  }
}

/** 粘贴到目标目录：剪切后清空剪贴板，复制则保留，最后刷新树 */
async function pasteInto(targetDir: string): Promise<boolean> {
  const ui = useUiStore.getState()
  if (!ui.fileClipboard) return false
  await pasteClipboard(ui.fileClipboard, targetDir)
  if (ui.fileClipboard.mode === 'cut') ui.setFileClipboard(null)
  await useNotesStore.getState().loadTree()
  return true
}

/**
 * 工作区文件树
 *
 * 目录在前、文件在后；支持内联新建 / 重命名、删除确认、右键菜单与快捷键。
 * 右键菜单对齐参考项目 `file-item.tsx`：新建、展开折叠、查看目录、模板、
 * 知识库、剪切 / 复制 / 创建副本 / 粘贴、上传下载文件夹、重命名、删除。
 */
export function FileTree({ nodes, keyword }: FileTreeProps) {
  const t = useT()
  const tree = useNotesStore((state) => state.tree)
  const newItem = useUiStore((state) => state.newItem)
  const startNewItem = useUiStore((state) => state.startNewItem)
  const setDirPickerOpen = useUiStore((state) => state.setDirPickerOpen)
  const showKbStatus = useSettingsStore((state) => state.fileView.showKnowledgeBaseStatus)
  const refreshKb = useKbStore((state) => state.refresh)
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const armed = useRef(false)

  // 搜索时强制展开全部，便于看到命中项
  const forcedExpand = Boolean(keyword)

  // 模板列表与知识库索引都是本地读取，进入文件树时各拉一次
  useEffect(() => {
    void rpc.listTemplates().then((result) => setTemplates(result.items)).catch(() => setTemplates([]))
  }, [tree])
  useEffect(() => {
    if (showKbStatus) void refreshKb()
  }, [showKbStatus, refreshKb, tree])

  /** 记录「最近交互落在文件树上」：快捷键只在这个状态下生效，避免抢编辑器的按键 */
  const focusTree = (path: string) => {
    armed.current = true
    useUiStore.getState().setSelectedTreePath(path)
  }

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      armed.current = Boolean(target?.closest('[data-file-tree], [data-tree-menu]'))
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!armed.current) return
      const active = document.activeElement as HTMLElement | null
      // 输入框 / 富文本编辑器里不拦截，Normal 打字、复制粘贴必须保持原生行为
      if (active?.closest('input, textarea, [contenteditable="true"]')) return
      const ui = useUiStore.getState()
      const path = ui.selectedTreePath
      if (!path) return
      const node = findTreeNode(useNotesStore.getState().tree, path)
      if (!node || node.remoteOnly) return
      const meta = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      if (event.key === 'F2') {
        event.preventDefault()
        ui.startRename(path)
      } else if (event.key === 'Delete') {
        event.preventDefault()
        ui.confirmDelete(path)
      } else if (meta && key === 'x') {
        event.preventDefault()
        ui.setFileClipboard({ mode: 'cut', path })
        toast.success(t('files.ctx.cutDone'))
      } else if (meta && key === 'c') {
        event.preventDefault()
        ui.setFileClipboard({ mode: 'copy', path })
        toast.success(t('files.ctx.copyDone'))
      } else if (meta && key === 'v') {
        event.preventDefault()
        void runAction(t, async () => {
          if (await pasteInto(targetDirOf(node))) toast.success(t('files.ctx.pasted'))
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [t])

  const content = (
    <>
      {nodes.length === 0 && newItem ? (
        <InlineInput kind={newItem.kind} parent={newItem.parent} level={0} />
      ) : (
        <>
          <TreeLevel nodes={nodes} level={0} forcedExpand={forcedExpand} parentPath="" onFocusTree={focusTree} templates={templates} />
          {newItem && newItem.parent === '' ? (
            <InlineInput kind={newItem.kind} parent="" level={0} />
          ) : null}
        </>
      )}
    </>
  )

  if (tree.length === 0 && !newItem) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4">
        <EmptyState
          title={t('files.empty')}
          description={t('files.emptyHint')}
          action={
            <div className="mt-1 flex gap-2">
              <Button size="sm" onClick={() => startNewItem('file', '')}>
                <FilePlus2 className="size-3.5" />
                {t('sidebar.newNote')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDirPickerOpen(true)}>
                {t('settings.change')}
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div data-file-tree className="h-full overflow-y-auto px-1.5 pb-4">
      {content}
    </div>
  )
}

function TreeLevel({
  nodes,
  level,
  forcedExpand,
  parentPath,
  onFocusTree,
  templates,
}: {
  nodes: TreeNode[]
  level: number
  forcedExpand: boolean
  parentPath: string
  onFocusTree: (path: string) => void
  templates: TemplateItem[]
}) {
  const newItem = useUiStore((state) => state.newItem)
  return (
    <>
      {newItem && newItem.parent === parentPath && parentPath !== '' ? (
        <InlineInput kind={newItem.kind} parent={parentPath} level={level} />
      ) : null}
      {nodes.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          level={level}
          forcedExpand={forcedExpand}
          onFocusTree={onFocusTree}
          templates={templates}
        />
      ))}
    </>
  )
}

/** 收集某个云端目录下的所有「仅云端」文件，供右键「下载整个目录」用 */
function remoteFilesIn(node: TreeNode): string[] {
  return remoteOnlyPaths(node.children ?? [], node.path)
}

function TreeRow({
  node,
  level,
  forcedExpand,
  onFocusTree,
  templates,
}: {
  node: TreeNode
  level: number
  forcedExpand: boolean
  onFocusTree: (path: string) => void
  templates: TemplateItem[]
}) {
  const t = useT()
  const activePath = useNotesStore((state) => state.activePath)
  const expanded = useNotesStore((state) => state.expanded)
  const toggleExpand = useNotesStore((state) => state.toggleExpand)
  const collapseAll = useNotesStore((state) => state.collapseAll)
  const open = useNotesStore((state) => state.open)

  const renameTarget = useUiStore((state) => state.renameTarget)
  const startRename = useUiStore((state) => state.startRename)
  const cancelRename = useUiStore((state) => state.cancelRename)
  const startNewItem = useUiStore((state) => state.startNewItem)
  const confirmDelete = useUiStore((state) => state.confirmDelete)
  const setImagePreview = useUiStore((state) => state.setImagePreview)
  const fileClipboard = useUiStore((state) => state.fileClipboard)
  const setFileClipboard = useUiStore((state) => state.setFileClipboard)
  const selectedTreePath = useUiStore((state) => state.selectedTreePath)

  const showKbStatus = useSettingsStore((state) => state.fileView.showKnowledgeBaseStatus)
  const syncStaticAssets = useSettingsStore((state) => state.fileView.syncStaticAssets)
  const kbPaths = useKbStore((state) => state.paths)
  const refreshKb = useKbStore((state) => state.refresh)

  const isFolder = node.kind === 'folder'
  const isImage = node.kind === 'image'
  const isRemoteOnly = Boolean(node.remoteOnly)
  const isRemoteUpdated = Boolean(node.remoteUpdated)
  const isOpen = forcedExpand || expanded.includes(node.path)
  const isActive = activePath === node.path
  const kbIndexed = showKbStatus && kbPaths.includes(node.path)

  /** 把仅云端条目下载到本地并刷新文件树 */
  const downloadRemote = async () => {
    const targets = isFolder ? remoteFilesIn(node) : [node.path]
    for (const target of targets) {
      await pullRemoteFileOnDemand(target)
    }
    await useNotesStore.getState().loadTree()
  }

  const downloadWithToast = () => {
    void downloadRemote().catch((error) =>
      toast.error(t('files.pullFailed', { message: errorMessage(error) })),
    )
  }

  /** 当前节点作为「新建 / 粘贴 / 上传」的目标目录 */
  const parentDir = isFolder ? node.path : dirName(node.path)
  const targetDir = targetDirOf(node)

  const handleClick = () => {
    onFocusTree(node.path)
    if (isFolder) {
      toggleExpand(node.path)
      return
    }
    // 图片没有编辑器，点开走预览弹窗；云端图片先下到本地再预览
    if (isImage) {
      if (isRemoteOnly) {
        void downloadRemote()
          .then(() => setImagePreview(node.path))
          .catch((error) =>
            toast.error(t('files.pullFailed', { message: errorMessage(error) })),
          )
        return
      }
      setImagePreview(node.path)
      return
    }
    void open(node.path).catch((error) => {
      toast.error(t('files.openFailed', { message: errorMessage(error) }))
    })
  }

  /** 新建（文件夹内 / 文件同级） */
  const createHere = (kind: 'file' | 'folder') => {
    if (isFolder) useNotesStore.getState().expandTo(`${node.path}/x`)
    startNewItem(kind, parentDir)
  }

  /** 上传文件夹：选本地目录，导入到当前目录 */
  const uploadFolder = async (directory: string) => {
    const result = await importLocalFiles(
      directory,
      'notes',
      { directory: true, accept: '' },
      syncStaticAssets,
    )
    if (!result) return
    await useNotesStore.getState().loadTree()
    if (result.imported === 0) {
      toast.message(t('files.more.nothingImported'))
    } else if (result.skipped > 0) {
      toast.success(t('files.more.importSkipped', { count: result.imported, skipped: result.skipped }))
    } else {
      toast.success(t('files.more.imported', { count: result.imported }))
    }
  }

  /** 下载文件夹：只拉该目录下「仅云端」的笔记 / 资源 */
  const downloadFolder = async (directory: string) => {
    const paths = remoteOnlyPaths(useNotesStore.getState().tree, directory).filter(
      (path) => syncStaticAssets || !isStaticAssetPath(path),
    )
    if (paths.length === 0) {
      toast.message(t('files.more.remoteEmpty'))
      return
    }
    const count = await downloadRemotePaths(paths)
    await useNotesStore.getState().loadTree()
    toast.success(t('files.more.remoteDone', { count }))
  }

  return (
    <>
      <ContextMenu onOpenChange={(opened) => { if (opened) onFocusTree(node.path) }}>
        <ContextMenuTrigger asChild>
          <div
            className="file-row relative"
            data-active={isActive}
            data-selected={selectedTreePath === node.path}
            data-tree-node={node.path}
            style={{ paddingLeft: 6 + level * 13 }}
            onClick={handleClick}
            role="treeitem"
            aria-expanded={isFolder ? isOpen : undefined}
            aria-selected={isActive}
            title={
              isRemoteOnly
                ? t('files.remoteOnly')
                : isRemoteUpdated
                  ? t('files.remoteUpdated')
                  : undefined
            }
          >
            {isFolder ? (
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform',
                  isOpen && 'rotate-90',
                )}
              />
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            {isFolder ? (
              isOpen ? (
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              )
            ) : isRemoteOnly ? (
              <CloudDownload className="size-3.5 shrink-0 text-sky-500" />
            ) : isImage ? (
              <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            )}

            {renameTarget === node.path ? (
              <InlineInput
                kind={isFolder ? 'folder' : 'file'}
                parent={node.path}
                level={-1}
                renamePath={node.path}
                initialValue={node.name}
                onDone={cancelRename}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-[13px]">{node.name.replace(/\.(md|markdown|txt)$/i, '')}</span>
            )}
            {kbIndexed ? (
              <Database className="size-3 shrink-0 text-emerald-500" aria-label={t('files.ctx.kbIndexed')} />
            ) : null}
            {isRemoteUpdated && !isRemoteOnly ? (
              <Cloud className="size-3 shrink-0 text-amber-500" aria-label={t('files.remoteUpdated')} />
            ) : null}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-56" data-tree-menu>
          {isRemoteOnly ? (
            // 本地磁盘上还没有这个条目：只提供下载，重命名 / 删除要等落地后才有意义
            <ContextMenuItem onSelect={downloadWithToast} data-tree-action="download">
              <CloudDownload />
              {isFolder ? t('files.downloadRemoteFolder') : t('files.downloadRemote')}
            </ContextMenuItem>
          ) : (
            <>
              {/* 新建 */}
              <ContextMenuItem onSelect={() => createHere('file')} data-tree-action="new-file">
                <FilePlus2 />
                {t('sidebar.newNote')}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => createHere('folder')} data-tree-action="new-folder">
                <FolderPlus />
                {t('sidebar.newFolder')}
              </ContextMenuItem>

              {/* 展开 / 折叠 */}
              {isFolder ? (
                <>
                  <ContextMenuSeparator />
                  {isOpen ? (
                    <ContextMenuItem onSelect={() => toggleExpand(node.path)} data-tree-action="collapse">
                      <ChevronsDownUp />
                      {t('files.ctx.collapse')}
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem onSelect={() => toggleExpand(node.path)} data-tree-action="expand">
                      <ChevronsUpDown />
                      {t('files.ctx.expand')}
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem onSelect={collapseAll} data-tree-action="collapse-all">
                    <ChevronsDownUp />
                    {t('files.more.collapseAll')}
                  </ContextMenuItem>
                </>
              ) : null}

              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => void runAction(t, () => revealEntry(node.path), 'files.ctx.revealed')}
                data-tree-action="reveal"
              >
                <ExternalLink />
                {t('files.ctx.reveal')}
              </ContextMenuItem>

              {/* 从模板新建笔记 */}
              <ContextMenuSub>
                <ContextMenuSubTrigger data-tree-action="template">
                  <LayoutTemplate />
                  {t('files.ctx.fromTemplate')}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {templates.length === 0 ? (
                    <ContextMenuLabel>{t('files.ctx.noTemplates')}</ContextMenuLabel>
                  ) : (
                    templates.map((template) => (
                      <ContextMenuItem
                        key={template.path}
                        onSelect={() =>
                          void runAction(
                            t,
                            async () => {
                              await createFromTemplate(parentDir, template)
                              await useNotesStore.getState().loadTree()
                            },
                            'files.ctx.fromTemplateDone',
                          )
                        }
                      >
                        <FileText />
                        {template.name}
                      </ContextMenuItem>
                    ))
                  )}
                </ContextMenuSubContent>
              </ContextMenuSub>

              {/* 知识库 */}
              <ContextMenuSub>
                <ContextMenuSubTrigger data-tree-action="kb">
                  <Database />
                  {t('files.ctx.kb')}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem
                    disabled={isFolder}
                    onSelect={() =>
                      void runAction(
                        t,
                        async () => {
                          await rpc.kbUpsert(node.path)
                          await refreshKb()
                        },
                        'files.ctx.kbUpdated',
                      )
                    }
                  >
                    <Database />
                    {t('files.ctx.kbUpdate')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      void runAction(
                        t,
                        async () => {
                          const result = await rpc.kbReindex()
                          await refreshKb()
                          toast.success(t('files.more.reindexed', { count: result.count }))
                        },
                      )
                    }
                  >
                    <RefreshCcwDot />
                    {t('files.ctx.kbReindexAll')}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>

              <ContextMenuSeparator />
              {/* 剪贴板 */}
              <ContextMenuItem
                onSelect={() => {
                  setFileClipboard({ mode: 'cut', path: node.path })
                  toast.success(t('files.ctx.cutDone'))
                }}
                data-tree-action="cut"
              >
                <Scissors />
                {t('files.ctx.cut')}
                <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  setFileClipboard({ mode: 'copy', path: node.path })
                  toast.success(t('files.ctx.copyDone'))
                }}
                data-tree-action="copy"
              >
                <Copy />
                {t('files.ctx.copy')}
                <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  void runAction(
                    t,
                    async () => {
                      const result = await duplicateEntry(node.path)
                      await useNotesStore.getState().loadTree()
                      if (result) toast.success(t('files.ctx.duplicated'))
                    },
                  )
                }
                data-tree-action="duplicate"
              >
                <Files />
                {t('files.ctx.duplicate')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!fileClipboard}
                onSelect={() =>
                  void runAction(t, async () => {
                    if (await pasteInto(targetDir)) toast.success(t('files.ctx.pasted'))
                  })
                }
                data-tree-action="paste"
              >
                <ClipboardPaste />
                {t('files.ctx.paste')}
                <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
              </ContextMenuItem>

              {/* 上传 / 下载文件夹 */}
              {isFolder ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => void runAction(t, () => uploadFolder(node.path))}
                    data-tree-action="upload-folder"
                  >
                    <Upload />
                    {t('files.ctx.uploadFolder')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => void runAction(t, () => downloadFolder(node.path))}
                    data-tree-action="download-folder"
                  >
                    <HardDriveDownload />
                    {t('files.ctx.downloadFolder')}
                  </ContextMenuItem>
                </>
              ) : null}

              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => {
                  useNotesStore.getState().expandTo(node.path)
                  startRename(node.path)
                }}
                data-tree-action="rename"
              >
                <Pencil />
                {t('common.rename')}
                <ContextMenuShortcut>F2</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
                onSelect={() => confirmDelete(node.path)}
                data-tree-action="delete"
              >
                <Trash2 />
                {t('common.delete')}
                <ContextMenuShortcut>Del</ContextMenuShortcut>
              </ContextMenuItem>

              {/* 开关项放在最后，方便右键时直接改视图偏好 */}
              <ContextMenuSeparator />
              <ContextMenuLabel>{t('files.more.view')}</ContextMenuLabel>
              <ContextMenuCheckboxItem
                checked={showKbStatus}
                onCheckedChange={(checked) => {
                  useSettingsStore.getState().patchFileView({ showKnowledgeBaseStatus: Boolean(checked) })
                  if (checked) void refreshKb()
                }}
                data-tree-action="show-kb"
              >
                <Database />
                {t('files.more.showKbStatus')}
              </ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem
                checked={syncStaticAssets}
                onCheckedChange={(checked) =>
                  useSettingsStore.getState().patchFileView({ syncStaticAssets: Boolean(checked) })
                }
                data-tree-action="sync-assets"
              >
                <CloudUpload />
                {t('files.more.syncAssets')}
              </ContextMenuCheckboxItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {isFolder && isOpen ? (
        <TreeLevel
          nodes={node.children ?? []}
          level={level + 1}
          forcedExpand={forcedExpand}
          parentPath={node.path}
          onFocusTree={onFocusTree}
          templates={templates}
        />
      ) : null}
    </>
  )
}

/**
 * 内联名称输入：新建（parent + kind）或重命名（renamePath）
 * Enter 提交，Esc 取消，失焦取消，避免误建。
 */
function InlineInput({
  kind,
  parent,
  level,
  renamePath,
  initialValue = '',
  onDone,
}: {
  kind: 'file' | 'folder'
  parent: string
  level: number
  renamePath?: string
  initialValue?: string
  onDone?: () => void
}) {
  const t = useT()
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const create = useNotesStore((state) => state.create)
  const rename = useNotesStore((state) => state.rename)
  const cancelNewItem = useUiStore((state) => state.cancelNewItem)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    // 重命名时选中主文件名，扩展名保持可见
    const dot = initialValue.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : initialValue.length)
  }, [initialValue])

  const finish = () => {
    onDone?.()
    cancelNewItem()
  }

  const submit = async () => {
    const name = value.trim()
    if (!name || busy) {
      if (!name) finish()
      return
    }
    setBusy(true)
    try {
      if (renamePath) {
        await rename(renamePath, name)
        toast.success(t('files.renamed'))
      } else {
        await create(kind, parent, name)
        toast.success(t('files.created'))
      }
      finish()
    } catch (error) {
      toast.error(t('toast.error', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex h-[30px] items-center gap-1.5 rounded-md bg-muted/60 pr-1"
      style={level >= 0 ? { paddingLeft: 6 + level * 13 } : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      {level >= 0 ? (
        kind === 'folder' ? (
          <Folder className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        )
      ) : null}
      <input
        ref={inputRef}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            finish()
          }
        }}
        onBlur={finish}
        placeholder={t('files.namePlaceholder')}
        className="h-6 min-w-0 flex-1 rounded border border-ring/40 bg-background px-1.5 text-[13px] outline-none"
      />
    </div>
  )
}
