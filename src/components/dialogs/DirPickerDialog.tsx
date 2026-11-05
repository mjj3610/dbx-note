import { useEffect, useState } from 'react'
import { ChevronLeft, Folder, FolderPlus, HardDrive, Home, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { listDirs, makeDir, setWorkspace, type DirListing } from '@/lib/rpc'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useRecordsStore } from '@/stores/records'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/**
 * 工作区目录选择器
 *
 * 沙箱里 `showDirectoryPicker` 会被拒绝，因此由 Sidecar 读盘、前端自绘目录树。
 */
export function DirPickerDialog() {
  const t = useT()
  const open = useUiStore((state) => state.dirPickerOpen)
  const setOpen = useUiStore((state) => state.setDirPickerOpen)

  const workspace = useSettingsStore((state) => state.workspace)
  const setWorkspaceInfo = useSettingsStore((state) => state.setWorkspace)

  const [listing, setListing] = useState<DirListing | null>(null)
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [folderName, setFolderName] = useState('')

  const load = async (target: string) => {
    setLoading(true)
    setError('')
    try {
      const result = await listDirs(target)
      setListing(result)
      setPath(result.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  // 打开时定位到当前工作区所在目录
  useEffect(() => {
    if (!open) return
    const start = workspace?.root ?? ''
    setCreating(false)
    setFolderName('')
    void load(start).catch(() => void load(''))
  }, [open])

  const apply = async (target: string) => {
    setApplying(true)
    try {
      const info = await setWorkspace(target)
      setWorkspaceInfo(info)
      await Promise.all([
        useNotesStore.getState().loadTree(),
        useRecordsStore.getState().load(),
      ])
      toast.success(t('toast.saved'))
      setOpen(false)
    } catch (cause) {
      toast.error(t('toast.error', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setApplying(false)
    }
  }

  const createFolder = async () => {
    const name = folderName.trim()
    if (!name || !listing) return
    try {
      const created = await makeDir(listing.path, name)
      setCreating(false)
      setFolderName('')
      await load(created.path)
    } catch (cause) {
      toast.error(t('toast.error', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dirPicker.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex h-[380px] gap-3">
          {/* 磁盘与快捷位置 */}
          <div className="w-40 shrink-0 overflow-y-auto rounded-lg border border-border p-1">
            <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t('dirPicker.drives')}</p>
            {(listing?.roots ?? []).map((root) => (
              <PickerRow key={root.path} active={path === root.path} onClick={() => void load(root.path)}>
                <HardDrive className="size-3.5" />
                <span className="truncate">{root.name}</span>
              </PickerRow>
            ))}

            <p className="mt-2 px-2 py-1 text-[11px] font-medium text-muted-foreground">{t('dirPicker.shortcuts.home')}</p>
            {(listing?.shortcuts ?? []).map((shortcut) => (
              <PickerRow key={shortcut.path} active={path === shortcut.path} onClick={() => void load(shortcut.path)}>
                {shortcut.key === 'home' ? <Home className="size-3.5" /> : <Folder className="size-3.5" />}
                <span className="truncate">{t(`dirPicker.shortcuts.${shortcut.key}`)}</span>
              </PickerRow>
            ))}
          </div>

          {/* 当前目录内容 */}
          <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
              <Button variant="ghost" size="icon-xs" disabled={!listing?.parent} onClick={() => void load(listing?.parent ?? '')}>
                <ChevronLeft className="size-3.5" />
              </Button>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={path}>
                {path || t('dirPicker.drives')}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                title={t('dirPicker.newFolder')}
                onClick={() => {
                  setCreating(true)
                  setFolderName('')
                }}
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </div>

            {creating ? (
              <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
                <Input
                  autoFocus
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder={t('dirPicker.namePrompt')}
                  className="h-7 text-xs"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void createFolder()
                    if (event.key === 'Escape') setCreating(false)
                  }}
                />
                <Button size="xs" onClick={() => void createFolder()} disabled={!folderName.trim()}>
                  {t('common.create')}
                </Button>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {loading ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <p className="px-2 py-3 text-xs text-destructive">{error}</p>
              ) : (listing?.entries.length ?? 0) === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">{t('dirPicker.empty')}</p>
              ) : (
                listing?.entries.map((entry) => (
                  <PickerRow key={entry.path} onClick={() => void load(entry.path)}>
                    <Folder className="size-3.5" />
                    <span className="truncate">{entry.name}</span>
                  </PickerRow>
                ))
              )}
            </div>

            <div className="flex h-8 shrink-0 items-center justify-between border-t border-border px-2 text-[11px]">
              <span className={listing?.writable === false ? 'text-destructive' : 'text-muted-foreground'}>
                {listing?.writable === false ? t('dirPicker.notWritable') : t('dirPicker.writable')}
              </span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!path || applying || listing?.writable === false} onClick={() => void apply(path)}>
            {applying ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('dirPicker.select')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PickerRow({
  active,
  onClick,
  children,
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs transition-colors ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
