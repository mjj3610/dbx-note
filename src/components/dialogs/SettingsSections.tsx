/**
 * 设置 → 记录 / 画布 / 快捷键 / 网络搜索 / 知识库 / 提示词 / MCP / 整理模板 / 插件
 *
 * 结构对齐 NoteGen 同名设置页：分组 + 卡片式单项 + 右侧控件。
 */
import { useEffect, useState } from 'react'
import {
  Book,
  Bot,
  Brain,
  ChartNoAxesColumnIncreasing,
  Database,
  Drama,
  Globe2,
  Keyboard,
  LayoutTemplate,
  ListTree,
  Palette,
  PenTool,
  Plug,
  Plus,
  RotateCcw,
  Trash2,
  Wand2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import * as rpc from '@/lib/rpc'
import { WEB_SEARCH_PROVIDERS, currentWebSearch } from '@/lib/webSearch'
import { useT } from '@/lib/useT'
import {
  BUILTIN_EDITOR_SHORTCUTS,
  DEFAULT_SHORTCUTS,
  DEFAULT_TEMPLATES,
  useSettingsStore,
} from '@/stores/settings'

import { Segmented, SettingItem, SettingPage, SettingSection } from './settings/Parts'

/* ---------------- 记录 ---------------- */

export function RecordSection() {
  const t = useT()
  const record = useSettingsStore((state) => state.record)
  const patch = useSettingsStore((state) => state.patch)
  const update = (next: Partial<typeof record>) => patch({ record: { ...record, ...next } })

  return (
    <SettingPage title={t('rec.title')} desc={t('rec.desc')}>
      <SettingSection title={t('rec.display.title')} desc={t('rec.display.desc')}>
        <SettingItem icon={ChartNoAxesColumnIncreasing} title={t('rec.view.title')} desc={t('rec.view.desc')}>
          <Segmented
            label={t('rec.view.title')}
            value={record.view}
            options={[
              { value: 'list' as const, label: t('rec.view.options.list') },
              { value: 'compact' as const, label: t('rec.view.options.compact') },
              { value: 'cards' as const, label: t('rec.view.options.cards') },
            ]}
            onChange={(value) => update({ view: value })}
          />
        </SettingItem>

        <SettingItem icon={ListTree} title={t('rec.sort.title')} desc={t('rec.sort.desc')}>
          <Segmented
            label={t('rec.sort.title')}
            value={record.sort}
            options={[
              { value: 'newest' as const, label: t('rec.sort.options.newest') },
              { value: 'oldest' as const, label: t('rec.sort.options.oldest') },
              { value: 'type' as const, label: t('rec.sort.options.type') },
            ]}
            onChange={(value) => update({ sort: value })}
          />
        </SettingItem>
      </SettingSection>

      <SettingSection title={t('rec.editing.title')} desc={t('rec.editing.desc')}>
        <SettingItem icon={PenTool} title={t('rec.defaultType.title')} desc={t('rec.defaultType.desc')}>
          <Segmented
            label={t('rec.defaultType.title')}
            value={record.defaultType}
            options={[
              { value: 'text' as const, label: t('rec.defaultType.options.text') },
              { value: 'link' as const, label: t('rec.defaultType.options.link') },
              { value: 'todo' as const, label: t('rec.defaultType.options.todo') },
            ]}
            onChange={(value) => update({ defaultType: value })}
          />
        </SettingItem>

        <SettingItem title={t('rec.focus.title')} desc={t('rec.focus.desc')}>
          <Switch
            aria-label={t('rec.focus.title')}
            checked={record.focusAfterSaved}
            onCheckedChange={(value) => update({ focusAfterSaved: value })}
          />
        </SettingItem>
      </SettingSection>
    </SettingPage>
  )
}

/* ---------------- 画布 ---------------- */

export function CanvasSection() {
  const t = useT()
  const canvas = useSettingsStore((state) => state.canvas)
  const patch = useSettingsStore((state) => state.patch)
  const update = (next: Partial<typeof canvas>) => patch({ canvas: { ...canvas, ...next } })

  return (
    <SettingPage title={t('cv.title')} desc={t('cv.desc')}>
      <SettingSection title={t('cv.display.title')} desc={t('cv.display.desc')}>
        <SettingItem icon={Palette} title={t('cv.showGrid.title')} desc={t('cv.showGrid.desc')}>
          <Switch
            aria-label={t('cv.showGrid.title')}
            checked={canvas.showGrid}
            onCheckedChange={(value) => update({ showGrid: value })}
          />
        </SettingItem>
        <SettingItem icon={Palette} title={t('cv.snap.title')} desc={t('cv.snap.desc')}>
          <Switch
            aria-label={t('cv.snap.title')}
            checked={canvas.snapToGrid}
            onCheckedChange={(value) => update({ snapToGrid: value })}
          />
        </SettingItem>
        <SettingItem title={t('cv.minimap.title')} desc={t('cv.minimap.desc')}>
          <Switch
            aria-label={t('cv.minimap.title')}
            checked={canvas.minimap}
            onCheckedChange={(value) => update({ minimap: value })}
          />
        </SettingItem>
        <SettingItem title={t('cv.gridStyle.title')} desc={t('cv.gridStyle.desc')}>
          <Segmented
            label={t('cv.gridStyle.title')}
            value={canvas.gridStyle}
            options={[
              { value: 'dots' as const, label: t('cv.gridStyle.options.dots') },
              { value: 'lines' as const, label: t('cv.gridStyle.options.lines') },
              { value: 'none' as const, label: t('cv.gridStyle.options.none') },
            ]}
            onChange={(value) => update({ gridStyle: value })}
          />
        </SettingItem>
        <SettingItem title={t('cv.gridGap.title')} desc={t('cv.gridGap.desc')}>
          <Segmented
            label={t('cv.gridGap.title')}
            value={String(canvas.gridGap)}
            options={[10, 20, 32, 48].map((value) => ({ value: String(value), label: `${value}px` }))}
            onChange={(value) => update({ gridGap: Number(value) })}
          />
        </SettingItem>
        <SettingItem title={t('cv.zoom.title')} desc={t('cv.zoom.desc')}>
          <Segmented
            label={t('cv.zoom.title')}
            value={String(canvas.defaultZoom)}
            options={[50, 75, 100, 150].map((value) => ({ value: String(value), label: `${value}%` }))}
            onChange={(value) => update({ defaultZoom: Number(value) })}
          />
        </SettingItem>
      </SettingSection>

      <SettingSection title={t('cv.interaction.title')} desc={t('cv.interaction.desc')}>
        <SettingItem title={t('cv.wheel.title')} desc={t('cv.wheel.desc')}>
          <Segmented
            label={t('cv.wheel.title')}
            value={canvas.wheel}
            options={[
              { value: 'zoom' as const, label: t('cv.wheel.options.zoom') },
              { value: 'pan' as const, label: t('cv.wheel.options.pan') },
            ]}
            onChange={(value) => update({ wheel: value })}
          />
        </SettingItem>
        <SettingItem title={t('cv.afterInsert.title')} desc={t('cv.afterInsert.desc')}>
          <Segmented
            label={t('cv.afterInsert.title')}
            value={canvas.afterInsert}
            options={[
              { value: 'keep' as const, label: t('cv.afterInsert.options.keep') },
              { value: 'select' as const, label: t('cv.afterInsert.options.select') },
            ]}
            onChange={(value) => update({ afterInsert: value })}
          />
        </SettingItem>
      </SettingSection>
    </SettingPage>
  )
}

/* ---------------- 快捷键 ---------------- */

const APP_ACTIONS = [
  'app.search',
  'app.newNote',
  'app.settings',
  'app.toggleSidebar',
  'app.toggleChat',
  'app.voice',
  'app.sync',
  'app.screenshot',
] as const

export function ShortcutsSection() {
  const t = useT()
  const shortcuts = useSettingsStore((state) => state.shortcuts)
  const patch = useSettingsStore((state) => state.patch)
  const [hotkey, setHotkey] = useState<rpc.ScreenshotHotkey | null>(null)

  // 全局截图热键由 Sidecar 注册（插件不在前台也能按），这里只展示实际生效的组合
  useEffect(() => {
    let alive = true
    void rpc
      .screenshotHotkey()
      .then((value) => {
        if (alive) setHotkey(value)
      })
      .catch(() => {
        if (alive) setHotkey({ combo: '', registered: false, reason: '后端不可用' })
      })
    return () => {
      alive = false
    }
  }, [])

  const setBinding = (action: string, combo: string) =>
    patch({ shortcuts: { bindings: { ...shortcuts.bindings, [action]: combo } } })

  return (
    <SettingPage
      title={t('sc.title')}
      desc={t('sc.desc')}
      action={
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              patch({ shortcuts: { bindings: { ...DEFAULT_SHORTCUTS } } })
              toast.success(t('toast.saved'))
            }}
          >
            <RotateCcw className="size-3.5" />
            {t('sc.resetDefaults')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const cleared = Object.fromEntries(Object.keys(shortcuts.bindings).map((key) => [key, '']))
              patch({ shortcuts: { bindings: cleared } })
            }}
          >
            {t('sc.clear')}
          </Button>
        </div>
      }
    >
      <SettingSection title={t('sc.app.title')} desc={t('sc.app.desc')}>
        {APP_ACTIONS.map((action) => (
          <SettingItem
            key={action}
            icon={Keyboard}
            title={t(`sc.action.${action}`)}
            desc={t(`sc.action.${action}.desc`)}
          >
            <Input
              value={shortcuts.bindings[action] ?? ''}
              onChange={(event) => setBinding(action, event.target.value)}
              placeholder={t('sc.empty')}
              aria-label={t(`sc.action.${action}`)}
              className="h-7 w-40 text-center text-[11px]"
            />
          </SettingItem>
        ))}

        <div
          data-shot-hotkey
          className="mt-1 rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
        >
          {hotkey?.registered
            ? t('shot.global.on', { combo: hotkey.combo })
            : t('shot.global.off', { reason: hotkey?.reason || t('common.loading') })}
        </div>
      </SettingSection>

      <SettingSection title={t('sc.builtin.title')} desc={t('sc.builtin.desc')}>
        <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border p-2">
          {BUILTIN_EDITOR_SHORTCUTS.map((item) => (
            <div key={item.labelKey} className="flex items-center justify-between gap-2 px-1">
              <span className="truncate text-[11px] text-muted-foreground">{t(item.labelKey)}</span>
              <kbd className="shrink-0 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">
                {item.combo}
              </kbd>
            </div>
          ))}
        </div>
      </SettingSection>
    </SettingPage>
  )
}

/* ---------------- 网络搜索 ---------------- */

export function WebSearchSection() {
  const t = useT()
  const webSearch = useSettingsStore((state) => state.webSearch)
  const patch = useSettingsStore((state) => state.patch)
  const update = (next: Partial<typeof webSearch>) => patch({ webSearch: { ...webSearch, ...next } })

  return (
    <SettingPage title={t('ws.title')} desc={t('ws.desc')}>
      <SettingSection>
        <SettingItem icon={Globe2} title={t('ws.enabled.title')} desc={t('ws.enabled.desc')}>
          <Switch
            aria-label={t('ws.enabled.title')}
            checked={webSearch.enabled}
            onCheckedChange={(value) => update({ enabled: value })}
          />
        </SettingItem>
        <SettingItem title={t('ws.native.title')} desc={t('ws.native.desc')} disabled={!webSearch.enabled}>
          <Switch
            aria-label={t('ws.native.title')}
            checked={webSearch.nativeEnabled}
            disabled={!webSearch.enabled}
            onCheckedChange={(value) => update({ nativeEnabled: value })}
          />
        </SettingItem>
        <SettingItem
          title={t('ws.thirdParty.title')}
          desc={t('ws.thirdParty.desc')}
          disabled={!webSearch.enabled}
        >
          <Switch
            aria-label={t('ws.thirdParty.title')}
            checked={webSearch.thirdPartyEnabled}
            disabled={!webSearch.enabled}
            onCheckedChange={(value) => update({ thirdPartyEnabled: value })}
          />
        </SettingItem>
      </SettingSection>

      <SettingSection title={t('ws.provider.title')} desc={t('ws.provider.desc')}>
        <Segmented
          label={t('ws.provider.title')}
          value={webSearch.provider}
          disabled={!webSearch.enabled || !webSearch.thirdPartyEnabled}
          options={WEB_SEARCH_PROVIDERS.map((value) => ({
            value,
            label: t(`ws.providers.${value}`),
          }))}
          onChange={(value) => update({ provider: value })}
        />
        <div className="space-y-1.5">
          <Label>{t('ws.apiKey')}</Label>
          <Input
            type="password"
            autoComplete="off"
            aria-label={t('ws.apiKey')}
            value={webSearch.apiKey}
            disabled={!webSearch.enabled || !webSearch.thirdPartyEnabled}
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder="tvly-..."
          />
          <p className="text-[11px] text-muted-foreground">
            {t('ws.snapshot', {
              state: currentWebSearch(webSearch) ? t('ws.ready') : t('ws.notReady'),
            })}
          </p>
        </div>
      </SettingSection>
    </SettingPage>
  )
}

/* ---------------- 知识库 ---------------- */

export function RagSection() {
  const t = useT()
  const knowledgeEnabled = useSettingsStore((state) => state.knowledgeEnabled)
  const patch = useSettingsStore((state) => state.patch)

  return (
    <SettingPage title={t('rag.title')} desc={t('rag.desc')}>
      <SettingSection>
        <SettingItem icon={Book} title={t('rag.enable.title')} desc={t('rag.enable.desc')}>
          <Switch
            aria-label={t('rag.enable.title')}
            checked={knowledgeEnabled}
            onCheckedChange={(value) => patch({ knowledgeEnabled: value })}
          />
        </SettingItem>
        <SettingItem icon={Database} title={t('rag.method.title')} desc={t('rag.method.desc')}>
          <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t('rag.method.value')}
          </span>
        </SettingItem>
      </SettingSection>
    </SettingPage>
  )
}

/* ---------------- 提示词 ---------------- */

export function PromptSection() {
  const t = useT()
  const prompt = useSettingsStore((state) => state.prompt)
  const patch = useSettingsStore((state) => state.patch)

  return (
    <SettingPage title={t('pm.title')} desc={t('pm.desc')}>
      <SettingSection title={t('pm.system.title')} desc={t('pm.system.desc')}>
        <Textarea
          rows={4}
          aria-label={t('pm.system.title')}
          value={prompt.systemExtra}
          onChange={(event) => patch({ prompt: { ...prompt, systemExtra: event.target.value } })}
          placeholder={t('pm.system.placeholder')}
        />
      </SettingSection>
      <SettingSection title={t('pm.organize.title')} desc={t('pm.organize.desc')}>
        <Textarea
          rows={5}
          aria-label={t('pm.organize.title')}
          value={prompt.organize}
          onChange={(event) => patch({ prompt: { ...prompt, organize: event.target.value } })}
        />
      </SettingSection>
    </SettingPage>
  )
}

/* ---------------- 整理模板 ---------------- */

export function TemplateSection() {
  const t = useT()
  const template = useSettingsStore((state) => state.template)
  const prompt = useSettingsStore((state) => state.prompt)
  const patch = useSettingsStore((state) => state.patch)
  const [draft, setDraft] = useState({ name: '', prompt: '' })

  const add = () => {
    const name = draft.name.trim()
    const body = draft.prompt.trim()
    if (!name || !body) return
    patch({
      template: {
        items: [...template.items, { id: `tpl-${Date.now()}`, name, prompt: body }],
      },
    })
    setDraft({ name: '', prompt: '' })
    toast.success(t('toast.saved'))
  }

  const remove = (id: string) =>
    patch({ template: { items: template.items.filter((item) => item.id !== id) } })

  return (
    <SettingPage
      title={t('tp.title')}
      desc={t('tp.desc')}
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            patch({ template: { items: [...DEFAULT_TEMPLATES] } })
            toast.success(t('toast.saved'))
          }}
        >
          <RotateCcw className="size-3.5" />
          {t('tp.restore')}
        </Button>
      }
    >
      <SettingSection title={t('tp.list.title')} desc={t('tp.list.desc')}>
        {template.items.map((item) => (
          <div key={item.id} className="rounded-lg border border-border p-3" data-template={item.id}>
            <div className="flex items-center gap-2">
              <LayoutTemplate className="size-3.5 text-muted-foreground" />
              <span className="flex-1 truncate text-[13px] font-medium">{item.name}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => patch({ prompt: { ...prompt, organize: item.prompt } })}
              >
                <Wand2 className="size-3.5" />
                {t('tp.use')}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`${t('common.delete')} ${item.name}`}
                onClick={() => remove(item.id)}
              >
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            </div>
            <Textarea
              rows={3}
              className="mt-2"
              aria-label={`${item.name} ${t('tp.promptLabel')}`}
              value={item.prompt}
              onChange={(event) =>
                patch({
                  template: {
                    items: template.items.map((entry) =>
                      entry.id === item.id ? { ...entry, prompt: event.target.value } : entry,
                    ),
                  },
                })
              }
            />
          </div>
        ))}
      </SettingSection>

      <SettingSection title={t('tp.add.title')} desc={t('tp.add.desc')}>
        <Input
          aria-label={t('tp.add.name')}
          placeholder={t('tp.add.name')}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <Textarea
          rows={3}
          aria-label={t('tp.add.prompt')}
          placeholder={t('tp.add.prompt')}
          value={draft.prompt}
          onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
        />
        <Button size="sm" variant="outline" disabled={!draft.name.trim() || !draft.prompt.trim()} onClick={add}>
          <Plus className="size-3.5" />
          {t('tp.add.action')}
        </Button>
      </SettingSection>
    </SettingPage>
  )
}

/* ---------------- 插件能力 ---------------- */

const CAPABILITIES = [
  'pl.cap.editor',
  'pl.cap.source',
  'pl.cap.image',
  'pl.cap.sync',
  'pl.cap.backup',
  'pl.cap.ai',
  'pl.cap.rag',
  'pl.cap.canvas',
  'pl.cap.record',
  'pl.cap.mcp',
] as const

export function PluginsSection() {
  const t = useT()
  const [version, setVersion] = useState('')

  useEffect(() => {
    void import('@/lib/constants').then((module) => setVersion(module.APP_VERSION))
  }, [])

  return (
    <SettingPage title={t('pl.title')} desc={t('pl.desc')}>
      <SettingSection title={t('pl.self.title')} desc={t('pl.self.desc')}>
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Bot className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">DBX Note</div>
              <div className="text-[11px] text-muted-foreground">v{version || '—'}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {CAPABILITIES.map((key) => (
              <div key={key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Brain className="size-3" />
                {t(key)}
              </div>
            ))}
          </div>
        </div>
      </SettingSection>
      <SettingSection title={t('pl.ext.title')} desc={t('pl.ext.desc')}>
        <SettingItem icon={Drama} title={t('pl.ext.name')} desc={t('pl.ext.hint')}>
          <Button size="sm" variant="outline" disabled>
            {t('pl.ext.coming')}
          </Button>
        </SettingItem>
      </SettingSection>
    </SettingPage>
  )
}
