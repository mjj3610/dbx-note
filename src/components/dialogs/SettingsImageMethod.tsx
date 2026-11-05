/**
 * 设置 → 图像识别
 *
 * 对齐 NoteGen `settings/imageMethod`：识别总开关 + 系统 OCR（可用状态 / 识别语言）
 * + VLM 增强（可选，配了才优先用视觉模型）。
 *
 * 顺序很重要：**VLM 优先，系统 OCR 兜底**。以前只有 VLM 一条腿，
 * 把纯文本模型（qwen3-8B 之类没有视觉能力的模型）填进来，记录上就只剩
 * "图片识别失败"；现在模型不管用也会自动回退系统 OCR 把文字读出来。
 */
import { useEffect, useState } from 'react'
import { Bot, ScanText, Sparkles } from 'lucide-react'

import { Input, Label, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import * as rpc from '@/lib/rpc'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'
import { cn } from '@/lib/utils'

import { SettingItem, SettingPage, SettingSection } from './settings/Parts'

interface OcrStatus {
  engine: string
  available: boolean
  languages: string[]
  active?: string
  error?: string
}

export function ImageMethodSection() {
  const t = useT()
  const imageMethod = useSettingsStore((state) => state.imageMethod)
  const ocr = useSettingsStore((state) => state.ocr)
  const patch = useSettingsStore((state) => state.patch)
  const [status, setStatus] = useState<OcrStatus | null>(null)

  // 系统 OCR 能不能用由 Sidecar 探测（有没有装 OCR 语言包）
  useEffect(() => {
    let alive = true
    rpc
      .ocrStatus()
      .then((value) => {
        if (alive) setStatus(value)
      })
      .catch(() => {
        if (alive) setStatus({ engine: 'windows-ocr', available: false, languages: [] })
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <SettingPage title={t('im.title')} desc={t('im.desc')}>
      <SettingSection>
        <SettingItem icon={ScanText} title={t('im.enable.title')} desc={t('im.enable.desc')}>
          <Switch
            aria-label={t('im.enable.title')}
            checked={imageMethod.enabled}
            onCheckedChange={(value) => patch({ imageMethod: { ...imageMethod, enabled: value } })}
          />
        </SettingItem>

        {/* 系统 OCR：WinRT 引擎，模型不可用时靠它兜底 */}
        <SettingItem icon={ScanText} title={t('im.engine.title')} desc={t('im.engine.desc')}>
          <span
            data-ocr-status={status ? (status.available ? 'ready' : 'unavailable') : 'probing'}
            className={cn(
              'rounded-md px-2 py-0.5 text-[11px]',
              status?.available
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {status === null
              ? t('im.engine.probing')
              : status.available
                ? t('im.engine.value')
                : t('im.engine.unavailable')}
          </span>
        </SettingItem>

        {status?.available && status.languages.length > 0 ? (
          <SettingItem icon={ScanText} title={t('im.engine.languages')} desc={t('im.engine.languagesDesc')}>
            <span className="max-w-[16rem] truncate text-right text-[11px] text-muted-foreground">
              {status.languages.join(' · ')}
            </span>
          </SettingItem>
        ) : null}

        {status && !status.available ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {status.error || t('im.engine.unavailableHint')}
          </p>
        ) : null}
      </SettingSection>

      <SettingSection title={t('im.vlm.title')} desc={t('im.vlm.desc')}>
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Bot className="mt-0.5 size-3 shrink-0" />
            {t('im.vlm.hint')}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>{t('settings.ai.baseUrl')}</Label>
              <Input
                value={ocr.baseUrl}
                onChange={(event) => patch({ ocr: { ...ocr, baseUrl: event.target.value } })}
                placeholder="https://api.openai.com/v1"
                aria-label={`${t('im.title')} ${t('settings.ai.baseUrl')}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('settings.ai.model')}</Label>
              <Input
                value={ocr.model}
                onChange={(event) => patch({ ocr: { ...ocr, model: event.target.value } })}
                placeholder="qwen2.5-vl-7b-instruct"
                aria-label={`${t('im.title')} ${t('settings.ai.model')}`}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('settings.ai.apiKey')}</Label>
            <Input
              type="password"
              autoComplete="off"
              value={ocr.apiKey}
              onChange={(event) => patch({ ocr: { ...ocr, apiKey: event.target.value } })}
              placeholder="sk-..."
              aria-label={`${t('im.title')} ${t('settings.ai.apiKey')}`}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('media.ocrPrompt')}</Label>
            <Textarea
              rows={3}
              value={ocr.prompt}
              onChange={(event) => patch({ ocr: { ...ocr, prompt: event.target.value } })}
              placeholder={t('media.ocrPromptPlaceholder')}
              aria-label={t('media.ocrPrompt')}
            />
          </div>
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Sparkles className="mt-0.5 size-3 shrink-0" />
            {t('im.model.hint')}
          </p>
          {ocr.baseUrl.trim() || ocr.model.trim() ? (
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-500">
              {t('im.vlm.visionOnly')}
            </p>
          ) : null}
        </div>
      </SettingSection>
    </SettingPage>
  )
}
