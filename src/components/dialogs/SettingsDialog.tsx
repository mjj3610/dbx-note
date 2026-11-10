import { useEffect, useState } from 'react'
import {
  ArchiveRestore,
  Book,
  BotMessageSquare,
  Brain,
  Check,
  CloudUpload,
  Drama,
  ExternalLink,
  FileCog,
  FolderOpen,
  Globe2,
  ImageUp,
  Info,
  Keyboard,
  LayoutTemplate,
  Loader2,
  Palette,
  PenTool,
  Puzzle,
  ScanText,
  Settings as SettingsIcon,
  Sparkles,
  Store,
  Volume2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { copyText } from '@/lib/bridge'
import * as rpc from '@/lib/rpc'
import { APP_HOMEPAGE, APP_VERSION, EDITOR_WIDTH_RANGE, FONT_SIZE_RANGE } from '@/lib/constants'
import { LOCALES, type Locale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useSettingsStore, type ThemeMode } from '@/stores/settings'
import { useUiStore, type SettingsTab } from '@/stores/ui'
import { AudioSection } from './SettingsAudio'
import { ModelsSection } from './SettingsModels'
import { EditorSection } from './SettingsEditor'
import { FileSection } from './SettingsFile'
import { ImageHostingSection } from './SettingsImageHosting'
import { ImageMethodSection } from './SettingsImageMethod'
import {
  CanvasSection,
  PluginsSection,
  PromptSection,
  RecordSection,
  ShortcutsSection,
  TemplateSection,
  WebSearchSection,
} from './SettingsSections'
import { RagSection } from './settings/RagSection'
import { MemoriesSection, SkillsSection } from './SettingsAssistant'
import { BackupSection, SyncSection } from './SettingsSync'
import { ToolsSection } from './SettingsTools'
import { SettingPage, SettingSection } from './settings/Parts'

type Group = 'basic' | 'ai' | 'data' | 'extensions'

interface NavItem {
  value: SettingsTab
  labelKey: string
  icon: typeof SettingsIcon
}

/** 左栏分组顺序与 NoteGen 完全一致 */
const NAV: Array<{ group?: Group; items?: NavItem[] }> = [
  {
    group: 'basic',
    items: [
      { value: 'about', labelKey: 'settings.about', icon: Store },
      { value: 'general', labelKey: 'settings.general', icon: SettingsIcon },
      { value: 'record', labelKey: 'nav.record', icon: PenTool },
      { value: 'editor', labelKey: 'nav.editor', icon: FileCog },
      { value: 'canvas', labelKey: 'nav.canvas', icon: Palette },
      { value: 'shortcuts', labelKey: 'nav.shortcuts', icon: Keyboard },
      { value: 'imageMethod', labelKey: 'nav.imageMethod', icon: ScanText },
      { value: 'audio', labelKey: 'nav.audio', icon: Volume2 },
    ],
  },
  {
    group: 'ai',
    items: [
      { value: 'ai', labelKey: 'settings.ai', icon: BotMessageSquare },
      { value: 'webSearch', labelKey: 'nav.webSearch', icon: Globe2 },
      { value: 'rag', labelKey: 'nav.rag', icon: Book },
      { value: 'memories', labelKey: 'nav.memories', icon: Brain },
      { value: 'prompt', labelKey: 'nav.prompt', icon: Drama },
      { value: 'mcp', labelKey: 'nav.mcp', icon: Puzzle },
      { value: 'skills', labelKey: 'nav.skills', icon: Sparkles },
      { value: 'template', labelKey: 'nav.template', icon: LayoutTemplate },
    ],
  },
  {
    group: 'data',
    items: [
      { value: 'sync', labelKey: 'settings.sync', icon: CloudUpload },
      { value: 'backup', labelKey: 'backup.title', icon: ArchiveRestore },
      { value: 'imageHosting', labelKey: 'ih.title', icon: ImageUp },
      { value: 'file', labelKey: 'nav.file', icon: FolderOpen },
    ],
  },
  {
    group: 'extensions',
    items: [{ value: 'plugins', labelKey: 'nav.plugins', icon: Puzzle }],
  },
]

/**
 * 设置弹窗
 *
 * 左栏按 NoteGen 的 basic / ai / data / extensions 分组，
 * 右栏渲染对应设置页。
 */
export function SettingsDialog() {
  const t = useT()
  const open = useUiStore((state) => state.settingsOpen)
  const tab = useUiStore((state) => state.settingsTab)
  const close = useUiStore((state) => state.closeSettings)
  const setTab = useUiStore((state) => state.openSettings)

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? close() : undefined)}>
      <DialogContent className="h-[640px] w-[1024px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0" hideClose>
        <div className="flex h-full min-h-0">
          <aside className="flex w-44 shrink-0 flex-col border-r border-border p-2">
            <DialogTitle className="px-2 py-1.5 text-[13px]">{t('settings.title')}</DialogTitle>
            <nav className="mt-1 min-h-0 flex-1 space-y-2 overflow-y-auto">
              {NAV.map((section) => (
                <div key={section.group ?? 'root'} className="space-y-0.5">
                  <div className="px-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground/70 uppercase">
                    {t(`settings.navigationGroups.${section.group}`)}
                  </div>
                  {section.items?.map((item) => {
                    const Icon = item.icon
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setTab(item.value)}
                        aria-current={tab === item.value ? 'page' : undefined}
                        className={cn(
                          'flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors',
                          tab === item.value
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        <Icon className="size-3.5 shrink-0" />
                        <span className="truncate">{t(item.labelKey)}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </nav>
            <button
              type="button"
              onClick={close}
              className="mt-2 flex h-7 shrink-0 items-center justify-center rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t('common.close')}
            </button>
          </aside>

          <div className="min-h-0 flex-1 overflow-y-auto p-5" data-settings-panel={tab}>
            {tab === 'about' ? <AboutSection /> : null}
            {tab === 'general' ? <GeneralSection /> : null}
            {tab === 'record' ? <RecordSection /> : null}
            {tab === 'editor' ? <EditorSection /> : null}
            {tab === 'canvas' ? <CanvasSection /> : null}
            {tab === 'shortcuts' ? <ShortcutsSection /> : null}
            {tab === 'imageMethod' ? <ImageMethodSection /> : null}
            {tab === 'audio' ? <AudioSection /> : null}
            {tab === 'ai' ? <ModelsSection /> : null}
            {tab === 'webSearch' ? <WebSearchSection /> : null}
            {tab === 'rag' ? <RagSection /> : null}
            {tab === 'memories' ? <MemoriesSection /> : null}
            {tab === 'prompt' ? <PromptSection /> : null}
            {tab === 'mcp' ? <ToolsSection /> : null}
            {tab === 'skills' ? <SkillsSection /> : null}
            {tab === 'template' ? <TemplateSection /> : null}
            {tab === 'sync' ? <SyncSection /> : null}
            {tab === 'backup' ? <BackupSection /> : null}
            {tab === 'imageHosting' ? <ImageHostingSection /> : null}
            {tab === 'file' ? <FileSection /> : null}
            {tab === 'plugins' ? <PluginsSection /> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- 常规 ---------------- */

function GeneralSection() {
  const t = useT()
  const theme = useSettingsStore((state) => state.theme)
  const locale = useSettingsStore((state) => state.locale)
  const fontSize = useSettingsStore((state) => state.fontSize)
  const editorWidth = useSettingsStore((state) => state.editorWidth)
  const knowledgeEnabled = useSettingsStore((state) => state.knowledgeEnabled)
  const patch = useSettingsStore((state) => state.patch)

  return (
    <SettingPage title={t('settings.general')} desc={t('settings.general.desc')}>
      <SettingSection title={t('settings.appearance')} desc={t('settings.appearance.desc')}>
        <SettingField label={t('settings.theme')}>
          <div className="inline-flex rounded-lg bg-muted p-0.5" role="group" aria-label={t('settings.theme')}>
            {(['light', 'dark', 'system'] as ThemeMode[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={theme === value}
                onClick={() => patch({ theme: value })}
                className={cn(
                  'h-7 rounded-md px-2.5 text-xs transition-colors',
                  theme === value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground',
                )}
              >
                {t(`settings.theme.${value}`)}
              </button>
            ))}
          </div>
        </SettingField>

        <SettingField label={t('settings.language')}>
          <select
            aria-label={t('settings.language')}
            value={locale}
            onChange={(event) => patch({ locale: event.target.value as Locale })}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none"
          >
            {LOCALES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </SettingField>
      </SettingSection>

      <SettingSection title={t('settings.reading')} desc={t('settings.reading.desc')}>
        <SettingField label={t('settings.fontSize')} hint={`${fontSize}px`}>
          <input
            type="range"
            aria-label={t('settings.fontSize')}
            min={FONT_SIZE_RANGE.min}
            max={FONT_SIZE_RANGE.max}
            step={FONT_SIZE_RANGE.step}
            value={fontSize}
            onChange={(event) => patch({ fontSize: Number(event.target.value) })}
            className="w-52 accent-primary"
          />
        </SettingField>

        <SettingField label={t('settings.editorWidth')} hint={`${editorWidth}px`}>
          <input
            type="range"
            aria-label={t('settings.editorWidth')}
            min={EDITOR_WIDTH_RANGE.min}
            max={EDITOR_WIDTH_RANGE.max}
            step={EDITOR_WIDTH_RANGE.step}
            value={editorWidth}
            onChange={(event) => patch({ editorWidth: Number(event.target.value) })}
            className="w-52 accent-primary"
          />
        </SettingField>
      </SettingSection>

      <SettingSection title={t('settings.behavior')} desc={t('settings.behavior.desc')}>
        <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <input
            type="checkbox"
            checked={knowledgeEnabled}
            onChange={(event) => patch({ knowledgeEnabled: event.target.checked })}
            aria-label={t('rag.enable.title')}
            className="size-3.5 accent-primary"
          />
          <span className="text-[13px]">{t('rag.enable.title')}</span>
        </label>
      </SettingSection>
    </SettingPage>
  )
}

function SettingField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

/* ---------------- 关于 ---------------- */

function AboutSection() {
  const t = useT()
  const workspace = useSettingsStore((state) => state.workspace)
  const [logOpen, setLogOpen] = useState(false)
  const [logText, setLogText] = useState('')
  const [logPath, setLogPath] = useState<string | null>(null)
  const [logSize, setLogSize] = useState(0)
  const [logLoading, setLogLoading] = useState(false)

  // 进「关于」页就取一次日志路径与体积，用户不用先点按钮才知道文件在哪
  useEffect(() => {
    let cancelled = false
    void rpc
      .logInfo()
      .then((result) => {
        if (cancelled) return
        setLogPath(result.path)
        setLogSize(result.size)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const loadLog = async () => {
    setLogLoading(true)
    try {
      const result = await rpc.logTail(300)
      setLogText(result.text)
      setLogPath(result.path)
    } catch (error) {
      toast.error(String(error instanceof Error ? error.message : error))
    } finally {
      setLogLoading(false)
    }
  }

  const showLog = () => {
    setLogOpen(true)
    if (!logText) void loadLog()
  }

  const openLogDir = async () => {
    try {
      await rpc.logOpen()
    } catch (error) {
      toast.error(String(error instanceof Error ? error.message : error))
    }
  }

  const copyLog = async () => {
    const ok = await copyText(logText)
    if (ok) toast.success(t('toast.copied'))
    else toast.error(t('toast.copyFailed'))
  }

  return (
    <SettingPage title={t('settings.about')} desc={t('settings.about.desc')}>
      <dl className="space-y-2 text-xs">
        <Row label={t('settings.about.version')} value={APP_VERSION} />
        <Row label={t('settings.about.dataDir')} value={workspace?.dataDir ?? '—'} />
        <Row label={t('settings.about.license')} value="GPL-3.0-or-later" />
      </dl>

      {/* Sidecar 日志：宿主把 stderr 收在自己的日志里，用户找不到，这里给一个直达入口 */}
      <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium">{t('settings.about.logs')}</span>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="outline" onClick={showLog} data-log-view>
              {t('settings.logs.view')}
            </Button>
            <Button size="xs" variant="ghost" onClick={openLogDir} data-log-open>
              <FolderOpen className="size-3" />
              {t('settings.logs.open')}
            </Button>
          </div>
        </div>
        <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
          {logPath ?? '—'}
          {logSize > 0 ? ` · ${formatBytes(logSize)}` : ''}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">{t('settings.about.logsHint')}</p>
      </div>

      <a
        href={APP_HOMEPAGE}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs text-info hover:underline"
      >
        {APP_HOMEPAGE}
        <ExternalLink className="size-3" />
      </a>

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Check className="size-3 text-success" />
        {t('settings.about.ready')}
      </div>

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogTitle>{t('settings.logs.title')}</DialogTitle>
          <pre
            data-sidecar-log
            className="max-h-[60vh] overflow-auto rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
          >
            {logText || t('settings.logs.empty')}
          </pre>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground">
              {logPath ?? ''}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => void loadLog()} disabled={logLoading}>
                {logLoading ? <Loader2 className="size-3 animate-spin" /> : null}
                {t('settings.logs.refresh')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copyLog()}>
                {t('common.copy')}
              </Button>
              <Button size="sm" onClick={() => void openLogDir()}>
                <FolderOpen className="size-3.5" />
                {t('settings.logs.open')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </SettingPage>
  )
}

/** 1024 → 1.0 KB，日志体积用 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-all">{value}</dd>
    </div>
  )
}
