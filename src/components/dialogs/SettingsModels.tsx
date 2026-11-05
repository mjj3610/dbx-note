/**
 * 设置 → AI 模型（多厂商 / 多模型）
 *
 * 对齐 NoteGen 的模型设置结构：
 * - 上方是「默认模型分配」：对话、图片识别、语音转写分别由哪个模型执行；
 * - 下方是厂商卡片：一个厂商 = 一个 baseURL + 一组密钥 + 若干模型，
 *   同一厂商下可以同时挂对话模型和视觉模型，互不干扰。
 *
 * 删除模型或厂商属于高危操作，会走二次确认，并提示默认模型将被自动改派。
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight, KeyRound, Loader2, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Badge, ConfirmDialog, Switch } from '@/components/ui/misc'
import { aiModels } from '@/lib/rpc'
import { PROVIDER_TEMPLATES, listModels } from '@/lib/aiConfig'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import {
  createModelConfig,
  createProvider,
  useSettingsStore,
  type AiModelConfig,
  type AiModelType,
  type AiProvider,
} from '@/stores/settings'
import { SettingPage, SettingSection } from './settings/Parts'

/** 实际有调用点的用途；embedding / tts 暂未使用，等接入后再放出来 */
const USAGE_TYPES: AiModelType[] = ['chat', 'vision', 'stt']

function ModelTypeSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: AiModelType
  onChange: (next: AiModelType) => void
  ariaLabel: string
}) {
  const t = useT()
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value as AiModelType)}
      className="h-8 shrink-0 rounded-md border border-border bg-transparent px-1.5 text-[12px] outline-none focus-visible:border-ring"
    >
      {USAGE_TYPES.map((type) => (
        <option key={type} value={type}>
          {t(`settings.ai.type.${type}`)}
        </option>
      ))}
    </select>
  )
}

/** 单个模型行：模型名 + 用途 + 删除，展开后是采样参数 */
function ModelRow({
  model,
  onUpdate,
  onRemove,
}: {
  model: AiModelConfig
  onUpdate: (patch: Partial<AiModelConfig>) => void
  onRemove: () => void
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-md border border-border/70" data-model-row={model.id}>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? t('settings.ai.collapse') : t('settings.ai.expand')}
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <input
          value={model.name}
          onChange={(event) => onUpdate({ name: event.target.value })}
          placeholder={t('settings.ai.modelName')}
          aria-label={t('settings.ai.modelName')}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none"
        />
        <ModelTypeSelect
          value={model.modelType}
          onChange={(next) => onUpdate({ modelType: next })}
          ariaLabel={t('settings.ai.modelType')}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('common.delete')}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {expanded ? (
        <div className="space-y-2 border-t border-border/70 px-2 py-2">
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">{t('settings.ai.temperature')}</span>
              <Input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={model.temperature}
                aria-label={t('settings.ai.temperature')}
                onChange={(event) => onUpdate({ temperature: Number(event.target.value) })}
                className="h-8 text-[12px]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">{t('settings.ai.topP')}</span>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={model.topP}
                aria-label={t('settings.ai.topP')}
                onChange={(event) => onUpdate({ topP: Number(event.target.value) })}
                className="h-8 text-[12px]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">{t('settings.ai.maxTokens')}</span>
              <Input
                type="number"
                min={0}
                step={128}
                value={model.maxTokens}
                aria-label={t('settings.ai.maxTokens')}
                onChange={(event) => onUpdate({ maxTokens: Number(event.target.value) })}
                className="h-8 text-[12px]"
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px]">{t('settings.ai.enableStream')}</p>
              <p className="text-[11px] text-muted-foreground">{t('settings.ai.enableStreamHint')}</p>
            </div>
            <Switch
              checked={model.enableStream}
              onCheckedChange={(value: boolean) => onUpdate({ enableStream: value })}
              aria-label={t('settings.ai.enableStream')}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t('settings.ai.maxTokensHint')}
          </p>
        </div>
      ) : null}
    </div>
  )
}

/** 厂商卡片：连接信息 + 模型列表 */
function ProviderCard({ provider }: { provider: AiProvider }) {
  const t = useT()
  const patchProvider = useSettingsStore((state) => state.patchProvider)
  const upsertModel = useSettingsStore((state) => state.upsertModel)
  const removeModel = useSettingsStore((state) => state.removeModel)
  const removeProvider = useSettingsStore((state) => state.removeProvider)

  const [fetched, setFetched] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const pullModels = async () => {
    setLoading(true)
    try {
      const result = await aiModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: '' })
      setFetched(result.items)
      if (result.items.length === 0) toast.warning(t('settings.ai.modelsEmpty'))
      else toast.success(t('settings.ai.fetched', { count: String(result.items.length) }))
    } catch (error) {
      toast.error(
        t('settings.ai.testFail', { message: error instanceof Error ? error.message : String(error) }),
      )
    } finally {
      setLoading(false)
    }
  }

  const addModel = (name: string) => {
    if (provider.models.some((model) => model.name === name && model.modelType === 'chat')) {
      toast.warning(t('settings.ai.duplicateModel', { name }))
      return
    }
    upsertModel(provider.id, createModelConfig(name, 'chat'))
  }

  return (
    <div className="rounded-lg border border-border" data-provider-card={provider.id}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Server className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={provider.name}
          onChange={(event) => patchProvider(provider.id, { name: event.target.value })}
          placeholder={t('settings.ai.providerName')}
          aria-label={t('settings.ai.providerName')}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
        />
        <Badge className="shrink-0">{t('settings.ai.modelCount', { count: String(provider.models.length) })}</Badge>
        <button
          type="button"
          onClick={() => setConfirmRemove(true)}
          aria-label={t('settings.ai.removeProvider')}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="space-y-2 px-3 py-2">
        {!provider.name && !provider.baseUrl ? (
          <div className="flex flex-wrap gap-1">
            {PROVIDER_TEMPLATES.filter((item) => item.key !== 'custom').map((template) => (
              <button
                key={template.key}
                type="button"
                onClick={() => patchProvider(provider.id, { name: template.name, baseUrl: template.baseUrl })}
                className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {template.name}
              </button>
            ))}
          </div>
        ) : null}

        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">{t('settings.ai.baseUrl')}</span>
          <Input
            value={provider.baseUrl}
            onChange={(event) => patchProvider(provider.id, { baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
            aria-label={t('settings.ai.baseUrl')}
            className="h-8 text-[12px]"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">{t('settings.ai.apiKey')}</span>
          <div className="flex gap-1.5">
            <Input
              type={showKey ? 'text' : 'password'}
              value={provider.apiKey}
              onChange={(event) => patchProvider(provider.id, { apiKey: event.target.value })}
              placeholder="sk-..."
              autoComplete="off"
              aria-label={t('settings.ai.apiKey')}
              className="h-8 text-[12px]"
            />
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setShowKey((value) => !value)}
              aria-label={showKey ? t('settings.ai.hideKey') : t('settings.ai.showKey')}
            >
              <KeyRound className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void pullModels()}
              disabled={loading || !provider.baseUrl}
            >
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t('settings.ai.test')}
            </Button>
          </div>
        </label>

        {fetched.length > 0 ? (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">{t('settings.ai.fetchedHint')}</p>
            <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
              {fetched.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => addModel(name)}
                  className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">{t('settings.ai.models')}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => upsertModel(provider.id, createModelConfig())}
              aria-label={t('settings.ai.addModel')}
            >
              <Plus className="size-3.5" />
              {t('settings.ai.addModel')}
            </Button>
          </div>
          {provider.models.length === 0 ? (
            <p className="rounded-md bg-muted/40 px-2 py-2 text-[11px] text-muted-foreground">
              {t('settings.ai.modelsHint')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {provider.models.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  onUpdate={(patch) => upsertModel(provider.id, { ...model, ...patch })}
                  onRemove={() => removeModel(provider.id, model.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={t('settings.ai.removeProvider')}
        description={t('settings.ai.removeProviderConfirm', { name: provider.name || provider.baseUrl })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          removeProvider(provider.id)
        }}
      />
    </div>
  )
}

/** 用途 → 模型的下拉行 */
function DefaultModelRow({ type }: { type: AiModelType }) {
  const t = useT()
  const ai = useSettingsStore((state) => state.ai)
  const setDefaultModel = useSettingsStore((state) => state.setDefaultModel)
  const options = listModels(ai, type)
  const value = ai.defaults[type]

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{t(`settings.ai.usage.${type}`)}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {t(`settings.ai.usage.${type}Hint`)}
        </p>
      </div>
      <select
        value={value}
        aria-label={t(`settings.ai.usage.${type}`)}
        onChange={(event) => setDefaultModel(type, event.target.value)}
        className={cn(
          'h-8 max-w-[46%] shrink-0 rounded-md border border-border bg-transparent px-1.5 text-[12px] outline-none',
          'focus-visible:border-ring',
        )}
      >
        <option value="">{t('settings.ai.notConfigured')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function ModelsSection() {
  const t = useT()
  const ai = useSettingsStore((state) => state.ai)
  const upsertProvider = useSettingsStore((state) => state.upsertProvider)

  return (
    <SettingPage
      title={t('settings.ai')}
      desc={t('settings.ai.desc')}
      action={
        <Button size="sm" variant="outline" onClick={() => upsertProvider(createProvider())}>
          <Plus className="size-3.5" />
          {t('settings.ai.addProvider')}
        </Button>
      }
    >
      <SettingSection title={t('settings.ai.defaults')} desc={t('settings.ai.defaultsHint')}>
        {USAGE_TYPES.map((type) => (
          <DefaultModelRow key={type} type={type} />
        ))}
      </SettingSection>

      <SettingSection title={t('settings.ai.providers')} desc={t('settings.ai.providersHint')}>
        {ai.providers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
            {t('settings.ai.noProviders')}
          </p>
        ) : (
          ai.providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)
        )}
      </SettingSection>
    </SettingPage>
  )
}
