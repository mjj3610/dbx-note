import { useEffect, useState } from 'react'
import { Palette, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { EmptyState } from '@/components/ui/misc'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { cn, relativeTime } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useCanvasStore } from '@/stores/canvas'

/**
 * 左栏「画布」页签：画布列表 + 新建 / 重命名 / 删除
 */
export function CanvasPanel() {
  const t = useT()
  const items = useCanvasStore((state) => state.items)
  const loading = useCanvasStore((state) => state.loading)
  const activePath = useCanvasStore((state) => state.activePath)
  const loadList = useCanvasStore((state) => state.loadList)
  const open = useCanvasStore((state) => state.open)
  const create = useCanvasStore((state) => state.create)
  const rename = useCanvasStore((state) => state.rename)
  const remove = useCanvasStore((state) => state.remove)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState('')

  useEffect(() => {
    void loadList()
  }, [loadList])

  const submitCreate = async () => {
    const value = name.trim()
    setCreating(false)
    setName('')
    if (!value) return
    await create(value)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-2 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('canvas.count', { count: items.length })}
        </span>
        <div className="flex items-center gap-0.5">
          <Hint label={t('canvas.new')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('canvas.new')}
              onClick={() => setCreating(true)}
            >
              <Plus className="size-4" />
            </Button>
          </Hint>
          <Hint label={t('common.refresh')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.refresh')}
              onClick={() => void loadList()}
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </Hint>
        </div>
      </div>

      {creating ? (
        <div className="shrink-0 px-2 pb-1.5">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void submitCreate()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitCreate()
              if (event.key === 'Escape') {
                setCreating(false)
                setName('')
              }
            }}
            placeholder={t('canvas.namePlaceholder')}
            className="h-7 w-full rounded border border-ring/60 bg-background px-2 text-xs outline-none"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {items.length === 0 && !creating ? (
          <EmptyState
            title={t('canvas.panelEmpty')}
            description={t('canvas.panelEmptyHint')}
            action={
              <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
                {t('canvas.new')}
              </Button>
            }
          />
        ) : null}

        {items.map((item) => {
          const active = item.path === activePath
          return (
            <ContextMenu key={item.path}>
              <ContextMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => void open(item.path)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void open(item.path)
                  }}
                  className={cn(
                    'group mb-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                    active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  <Palette className={cn('size-3.5 shrink-0', active && 'text-primary')} />
                  {editing === item.path ? (
                    <input
                      autoFocus
                      defaultValue={item.title}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) => {
                        const value = event.target.value.trim()
                        setEditing('')
                        if (value && value !== item.title) void rename(item.path, value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                        if (event.key === 'Escape') setEditing('')
                      }}
                      className="h-6 min-w-0 flex-1 rounded border border-ring/60 bg-background px-1 text-xs outline-none"
                    />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/70 group-hover:hidden">
                        {relativeTime(item.updatedAt)}
                      </span>
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => setEditing(item.path)}>
                  <Pencil />
                  {t('common.rename')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
                  onSelect={() => void remove(item.path)}
                >
                  <Trash2 />
                  {t('common.delete')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
    </div>
  )
}
