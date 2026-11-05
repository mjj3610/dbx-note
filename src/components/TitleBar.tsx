import { useState } from 'react'
import { FolderOpen, Moon, PanelLeft, PanelRight, Search, Settings, Sun, NotebookPen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { Kbd } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useIsNarrow } from '@/lib/useMediaQuery'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/**
 * 顶部工具栏
 *
 * 保持 36px 高度与桌面端一致：左侧品牌与工作区，右侧搜索、面板开关、外观与设置。
 */
export function TitleBar() {
  const t = useT()
  // 窄屏：隐藏品牌名、工作区名、搜索框与面板开关，只留搜索入口、外观与设置
  const narrow = useIsNarrow()
  const [hoverSearch, setHoverSearch] = useState(false)
  const theme = useSettingsStore((state) => state.theme)
  const patch = useSettingsStore((state) => state.patch)
  const workspace = useSettingsStore((state) => state.workspace)
  const leftVisible = useUiStore((state) => state.leftVisible)
  const rightVisible = useUiStore((state) => state.rightVisible)
  const toggleLeft = useUiStore((state) => state.toggleLeft)
  const toggleRight = useUiStore((state) => state.toggleRight)
  const setSearchOpen = useUiStore((state) => state.setSearchOpen)
  const setDirPickerOpen = useUiStore((state) => state.setDirPickerOpen)
  const openSettings = useUiStore((state) => state.openSettings)

  const workspaceName = workspace?.root?.split(/[\\/]/).filter(Boolean).pop() ?? t('files.root')
  const dark = theme === 'dark'

  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <NotebookPen className="size-3.5" />
        </div>
        {narrow ? null : (
          <>
            <span className="truncate text-[13px] font-semibold">{t('app.name')}</span>
            <button
              type="button"
              onClick={() => setDirPickerOpen(true)}
              className="ml-1 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={workspace?.root ?? ''}
            >
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="max-w-[180px] truncate">{workspaceName}</span>
            </button>
          </>
        )}
      </div>

      {narrow ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.search')}
          onClick={() => setSearchOpen(true)}
          className="ml-1"
        >
          <Search className="size-4" />
        </Button>
      ) : (
      <div className="flex flex-1 justify-center">
        <button
          type="button"
          onMouseEnter={() => setHoverSearch(true)}
          onMouseLeave={() => setHoverSearch(false)}
          onClick={() => setSearchOpen(true)}
          className={cn(
            'flex h-7 w-full max-w-[320px] items-center gap-2 rounded-md border border-border/80 px-2 text-xs text-muted-foreground transition-colors',
            hoverSearch ? 'bg-muted text-foreground' : 'bg-muted/40',
          )}
        >
          <Search className="size-3.5" />
          <span className="flex-1 truncate text-left">{t('sidebar.searchPlaceholder')}</span>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>
      )}

      <div className={cn('flex items-center gap-0.5', narrow && 'ml-auto')}>
        {narrow ? null : (
        <>
        <Hint label={t('sidebar.toggle')}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleLeft}
            aria-label={t('sidebar.toggle')}
            className={cn(!leftVisible && 'text-muted-foreground')}
          >
            <PanelLeft className="size-4" />
          </Button>
        </Hint>
        <Hint label={t('chat.title')}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleRight}
            aria-label={t('chat.title')}
            className={cn(!rightVisible && 'text-muted-foreground')}
          >
            <PanelRight className="size-4" />
          </Button>
        </Hint>
        </>
        )}
        <Hint label={dark ? t('settings.theme.light') : t('settings.theme.dark')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('settings.theme')}
            onClick={() => patch({ theme: dark ? 'light' : 'dark' })}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </Hint>
        <Hint label={t('common.settings')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.settings')}
            onClick={() => openSettings('general')}
          >
            <Settings className="size-4" />
          </Button>
        </Hint>
      </div>
    </header>
  )
}
