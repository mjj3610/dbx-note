import { useEffect, useRef } from 'react'
import { FileText, FolderOpen, MessageSquareText, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { currentFolder, useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'

/**
 * 编辑器标签栏（对齐 NoteGen 的 tab-bar）
 *
 * - 左侧标签可横向滚动，激活标签带底部高亮条；
 * - 每个标签右键可关闭自身 / 其他 / 左侧 / 右侧 / 全部；
 * - 右侧插槽放保存状态与视图切换，保持单行 48px。
 */
export function EditorTabBar({ children }: { children?: React.ReactNode }) {
  const t = useT()
  const tabs = useNotesStore((state) => state.tabs)
  const activePath = useNotesStore((state) => state.activePath)
  const open = useNotesStore((state) => state.open)
  const closeTab = useNotesStore((state) => state.closeTab)
  const closeTabs = useNotesStore((state) => state.closeTabs)
  const closeOtherTabs = useNotesStore((state) => state.closeOtherTabs)
  const closeAllTabs = useNotesStore((state) => state.closeAllTabs)

  const startNewItem = useUiStore((state) => state.startNewItem)
  const setDirPickerOpen = useUiStore((state) => state.setDirPickerOpen)
  const setTab = useUiStore((state) => state.setTab)

  const listRef = useRef<HTMLDivElement | null>(null)

  // 激活标签滚入可视区，标签多到溢出时也能看到当前页
  useEffect(() => {
    const target = Array.from(listRef.current?.children ?? []).find(
      (node) => node instanceof HTMLElement && node.dataset.tabPath === activePath,
    )
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [activePath, tabs.length])

  if (tabs.length === 0) return null

  return (
    <div className="flex h-12 shrink-0 items-center border-b border-border bg-background">
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('tab.list')}
        className="flex h-full min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab) => {
          const isActive = tab.path === activePath
          const index = tabs.findIndex((item) => item.path === tab.path)
          const hasLeft = index > 0
          const hasRight = index >= 0 && index < tabs.length - 1
          return (
            <ContextMenu key={tab.path}>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={0}
                  data-tab-path={tab.path}
                  title={tab.path}
                  onClick={() => void open(tab.path)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      void open(tab.path)
                    }
                  }}
                  onAuxClick={(event) => {
                    // 中键关闭，和桌面端习惯一致
                    if (event.button !== 1) return
                    event.preventDefault()
                    void closeTab(tab.path)
                  }}
                  className={cn(
                    'group relative flex h-12 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 px-3 text-sm transition-colors',
                    isActive
                      ? 'bg-muted/40 font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <FileText className={cn('size-4 shrink-0', isActive && 'text-primary')} />
                  <span className="truncate">{tab.name}</span>
                  <span className="relative ml-1 flex size-5 shrink-0 items-center justify-center">
                    {tab.dirty ? (
                      <span
                        aria-label={t('tab.dirty')}
                        className="size-1.5 rounded-full bg-primary transition-opacity group-hover:opacity-0"
                      />
                    ) : null}
                    <button
                      type="button"
                      aria-label={`${t('tab.close')}: ${tab.name}`}
                      className="absolute inset-0 flex items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted-foreground/20 group-hover:opacity-100"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        void closeTab(tab.path)
                      }}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                  {isActive ? <div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" /> : null}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => void closeTab(tab.path)}>
                  {t('tab.close')}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={tabs.length <= 1}
                  onSelect={() => void closeOtherTabs(tab.path)}
                >
                  {t('tab.closeOthers')}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!hasLeft}
                  onSelect={() => void closeTabs(tabs.slice(0, index).map((item) => item.path))}
                >
                  {t('tab.closeLeft')}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!hasRight}
                  onSelect={() => void closeTabs(tabs.slice(index + 1).map((item) => item.path))}
                >
                  {t('tab.closeRight')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void closeAllTabs()}>
                  {t('tab.closeAll')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="mx-1 shrink-0" aria-label={t('tab.newNote')}>
              <Plus className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => startNewItem('file', currentFolder())}>
              <FileText />
              {t('tab.newNote')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTab('records')}>
              <MessageSquareText />
              {t('tab.newRecord')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDirPickerOpen(true)}>
              <FolderOpen />
              {t('tab.openWorkspace')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {children ? <div className="flex shrink-0 items-center gap-1 px-2">{children}</div> : null}
    </div>
  )
}
