import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Pencil,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { EmptyState } from '@/components/ui/misc'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { Button } from '@/components/ui/button'
import type { TreeNode } from '@/lib/rpc'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'

interface FileTreeProps {
  nodes: TreeNode[]
  keyword: string
}

/**
 * 工作区文件树
 *
 * 目录在前、文件在后；支持内联新建、内联重命名、右键菜单与删除确认。
 */
export function FileTree({ nodes, keyword }: FileTreeProps) {
  const t = useT()
  const tree = useNotesStore((state) => state.tree)
  const newItem = useUiStore((state) => state.newItem)
  const startNewItem = useUiStore((state) => state.startNewItem)
  const setDirPickerOpen = useUiStore((state) => state.setDirPickerOpen)

  // 搜索时强制展开全部，便于看到命中项
  const forcedExpand = Boolean(keyword)

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
    <div className="h-full overflow-y-auto px-1.5 pb-4">
      {nodes.length === 0 && newItem ? (
        <InlineInput kind={newItem.kind} parent={newItem.parent} level={0} />
      ) : (
        <>
          <TreeLevel nodes={nodes} level={0} forcedExpand={forcedExpand} parentPath="" />
          {newItem && newItem.parent === '' ? (
            <InlineInput kind={newItem.kind} parent="" level={0} />
          ) : null}
        </>
      )}
    </div>
  )
}

function TreeLevel({
  nodes,
  level,
  forcedExpand,
  parentPath,
}: {
  nodes: TreeNode[]
  level: number
  forcedExpand: boolean
  parentPath: string
}) {
  const newItem = useUiStore((state) => state.newItem)
  return (
    <>
      {newItem && newItem.parent === parentPath && parentPath !== '' ? (
        <InlineInput kind={newItem.kind} parent={parentPath} level={level} />
      ) : null}
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} level={level} forcedExpand={forcedExpand} />
      ))}
    </>
  )
}

function TreeRow({ node, level, forcedExpand }: { node: TreeNode; level: number; forcedExpand: boolean }) {
  const t = useT()
  const activePath = useNotesStore((state) => state.activePath)
  const expanded = useNotesStore((state) => state.expanded)
  const toggleExpand = useNotesStore((state) => state.toggleExpand)
  const open = useNotesStore((state) => state.open)
  const expandTo = useNotesStore((state) => state.expandTo)

  const renameTarget = useUiStore((state) => state.renameTarget)
  const startRename = useUiStore((state) => state.startRename)
  const cancelRename = useUiStore((state) => state.cancelRename)
  const startNewItem = useUiStore((state) => state.startNewItem)
  const confirmDelete = useUiStore((state) => state.confirmDelete)
  const setImagePreview = useUiStore((state) => state.setImagePreview)

  const isFolder = node.kind === 'folder'
  const isImage = node.kind === 'image'
  const isOpen = forcedExpand || expanded.includes(node.path)
  const isActive = activePath === node.path

  const handleClick = () => {
    if (isFolder) {
      toggleExpand(node.path)
      return
    }
    // 图片没有编辑器，点开走预览弹窗
    if (isImage) {
      setImagePreview(node.path)
      return
    }
    void open(node.path).catch((error) => {
      toast.error(t('files.openFailed', { message: error instanceof Error ? error.message : String(error) }))
    })
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="file-row relative"
            data-active={isActive}
            style={{ paddingLeft: 6 + level * 13 }}
            onClick={handleClick}
            role="treeitem"
            aria-expanded={isFolder ? isOpen : undefined}
            aria-selected={isActive}
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
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {isFolder ? (
            <>
              <ContextMenuItem onSelect={() => startNewItem('file', node.path)}>
                <FilePlus2 />
                {t('sidebar.newNote')}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => startNewItem('folder', node.path)}>
                <FolderPlus />
                {t('sidebar.newFolder')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
          <ContextMenuItem
            onSelect={() => {
              expandTo(node.path)
              startRename(node.path)
            }}
          >
            <Pencil />
            {t('common.rename')}
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
            onSelect={() => confirmDelete(node.path)}
          >
            <Trash2 />
            {t('common.delete')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isFolder && isOpen ? (
        <TreeLevel
          nodes={node.children ?? []}
          level={level + 1}
          forcedExpand={forcedExpand}
          parentPath={node.path}
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
      toast.error(t('toast.error', { message: error instanceof Error ? error.message : String(error) }))
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
