/**
 * 设置 → 文件管理
 *
 * 对齐 NoteGen `settings/file`：工作区路径（含默认工作区 / 切换 / 重置）+ 资源目录。
 */
import { useState } from 'react'
import { Check, FolderOpen, FolderCog, History, Image as ImageIcon, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { resetWorkspace, setWorkspace } from '@/lib/rpc'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

import { Segmented, SettingItem, SettingPage, SettingSection } from './settings/Parts'

const NAME_MODES = ['uuid', 'date', 'original'] as const

export function FileSection() {
  const t = useT()
  const workspace = useSettingsStore((state) => state.workspace)
  const setWorkspaceInfo = useSettingsStore((state) => state.setWorkspace)
  const image = useSettingsStore((state) => state.image)
  const patch = useSettingsStore((state) => state.patch)
  const setDirPickerOpen = useUiStore((state) => state.setDirPickerOpen)
  const [busy, setBusy] = useState(false)

  const reset = async () => {
    setBusy(true)
    try {
      const info = await resetWorkspace()
      setWorkspaceInfo(info)
      await useNotesStore.getState().loadTree()
      toast.success(t('toast.saved'))
    } catch (error) {
      toast.error(t('toast.error', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const changeTo = async (path: string) => {
    setBusy(true)
    try {
      const info = await setWorkspace(path)
      setWorkspaceInfo(info)
      await useNotesStore.getState().loadTree()
      toast.success(t('toast.saved'))
    } catch (error) {
      toast.error(t('toast.error', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingPage title={t('file.title')} desc={t('file.desc')}>
      <SettingSection title={t('settings.workspace')} desc={t('settings.workspaceHint')}>
        <SettingItem icon={FolderCog} title={t('settings.workspacePath')} desc={workspace?.root ?? '—'} stacked>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setDirPickerOpen(true)} disabled={busy}>
              <FolderOpen className="size-3.5" />
              {t('settings.change')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void reset()} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              {t('settings.resetWorkspace')}
            </Button>
            {workspace?.defaultRoot ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void changeTo(workspace.defaultRoot)}
                disabled={busy}
              >
                <History className="size-3.5" />
                {t('settings.defaultWorkspace')}
              </Button>
            ) : null}
          </div>
          {workspace ? (
            <div className="space-y-0.5 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Check className="size-3 text-success" />
                {workspace.writable ? t('dirPicker.writable') : t('dirPicker.notWritable')}
                <span className="ml-1">{t('settings.fileCount', { count: workspace.fileCount })}</span>
              </div>
              <div className="break-all">
                {t('settings.about.dataDir')}：{workspace.dataDir}
              </div>
            </div>
          ) : null}
        </SettingItem>
      </SettingSection>

      <SettingSection title={t('file.assets.title')} desc={t('file.assets.desc')}>
        <SettingItem icon={ImageIcon} title={t('media.imageDir')} desc={t('media.imageDirHint')} stacked>
          <Input
            value={image.dir}
            onChange={(event) => patch({ image: { ...image, dir: event.target.value } })}
            placeholder="assets"
            aria-label={t('media.imageDir')}
          />
        </SettingItem>
        <SettingItem title={t('media.nameMode')} stacked>
          <Segmented
            label={t('media.nameMode')}
            value={image.nameMode}
            options={NAME_MODES.map((mode) => ({ value: mode, label: t(`media.nameMode.${mode}`) }))}
            onChange={(value) => patch({ image: { ...image, nameMode: value } })}
          />
        </SettingItem>
      </SettingSection>

      <SettingSection title={t('file.reveal.title')} desc={t('file.reveal.desc')}>
        <div className="space-y-1.5">
          <Label>{t('file.reveal.path')}</Label>
          <div className="rounded-lg border border-border bg-muted/20 px-2.5 py-2 text-[11px] break-all">
            {workspace?.root ?? '—'}
          </div>
        </div>
      </SettingSection>

      <SettingSection title={t('media.shortcut')} desc={t('media.shortcutHint')}>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t('file.paste.hint')}</p>
      </SettingSection>
    </SettingPage>
  )
}
