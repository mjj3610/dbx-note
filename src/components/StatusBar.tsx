import { HardDrive, Save } from 'lucide-react'

import { countWords } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'

/**
 * 底部状态栏（28px）：工作区、字数、保存状态
 */
export function StatusBar() {
  const t = useT()
  const workspace = useSettingsStore((state) => state.workspace)
  const activePath = useNotesStore((state) => state.activePath)
  const content = useNotesStore((state) => state.content)
  const saveState = useNotesStore((state) => state.saveState)

  const saveLabel =
    saveState === 'saving'
      ? t('status.saving')
      : saveState === 'error'
        ? t('status.unsaved')
        : saveState === 'saved'
          ? t('status.saved')
          : ''

  return (
    <footer className="flex h-7 min-h-7 shrink-0 items-center gap-3 border-t border-border bg-background px-2.5 text-[11px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1">
        <HardDrive className="size-3 shrink-0" />
        <span className="max-w-[280px] truncate" title={workspace?.root ?? ''}>
          {workspace?.root ?? t('status.noSidecar')}
        </span>
      </span>

      {workspace ? (
        <span className="hidden shrink-0 sm:inline">{t('settings.fileCount', { count: workspace.fileCount })}</span>
      ) : null}

      <span className="flex-1" />

      {saveLabel ? (
        <span className="flex shrink-0 items-center gap-1">
          <Save className="size-3" />
          {saveLabel}
        </span>
      ) : null}

      {activePath ? <span className="shrink-0">{t('status.words', { count: countWords(content) })}</span> : null}
      <span className="hidden shrink-0 md:inline">{activePath}</span>
    </footer>
  )
}
