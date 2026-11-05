/**
 * 设置 → 语音
 *
 * 对齐 NoteGen `settings/audio`：运行方式（自动 / 仅本地 / 仅模型）、
 * 朗读语速，以及语音转写（STT）模型配置。
 */
import { Mic, Volume2 } from 'lucide-react'

import { Input, Label } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'

import { Segmented, SettingItem, SettingPage, SettingSection } from './settings/Parts'

export function AudioSection() {
  const t = useT()
  const audio = useSettingsStore((state) => state.audio)
  const voice = useSettingsStore((state) => state.voice)
  const patch = useSettingsStore((state) => state.patch)
  const update = (next: Partial<typeof audio>) => patch({ audio: { ...audio, ...next } })

  return (
    <SettingPage title={t('au.title')} desc={t('au.desc')}>
      <SettingSection title={t('au.mode.title')} desc={t('au.mode.desc')}>
        <Segmented
          label={t('au.mode.title')}
          value={audio.mode}
          options={[
            { value: 'auto' as const, label: t('au.mode.auto') },
            { value: 'local' as const, label: t('au.mode.local') },
            { value: 'model' as const, label: t('au.mode.model') },
          ]}
          onChange={(value) => update({ mode: value })}
        />
      </SettingSection>

      <SettingSection title={t('au.tts.title')} desc={t('au.tts.desc')}>
        <SettingItem icon={Volume2} title={t('au.speed.title')} desc={t('au.speed.desc')} stacked>
          <div className="flex items-center gap-3">
            <input
              type="range"
              aria-label={t('au.speed.title')}
              min={0.5}
              max={2}
              step={0.1}
              value={audio.speed}
              onChange={(event) => update({ speed: Number(event.target.value) })}
              className="w-52 accent-primary"
            />
            <span className="text-[11px] text-muted-foreground">{audio.speed.toFixed(1)}×</span>
          </div>
        </SettingItem>
      </SettingSection>

      <SettingSection title={t('au.stt.title')} desc={t('au.stt.desc')}>
        {/* 宿主沙箱的麦克风限制要说清楚，否则用户只会看到「点了没反应」 */}
        <p
          data-host-mic-hint
          className="mb-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
        >
          {t('voice.recordFallback')}
        </p>
        <SettingItem icon={Mic} title={t('au.recognize.title')} desc={t('au.recognize.desc')}>
          <Switch
            aria-label={t('au.recognize.title')}
            checked={audio.recognitionEnabled}
            disabled={audio.mode === 'local'}
            onCheckedChange={(value) => update({ recognitionEnabled: value })}
          />
        </SettingItem>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>{t('settings.ai.baseUrl')}</Label>
              <Input
                value={voice.baseUrl}
                onChange={(event) => patch({ voice: { ...voice, baseUrl: event.target.value } })}
                placeholder="https://api.openai.com/v1"
                aria-label={`${t('au.title')} ${t('settings.ai.baseUrl')}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('media.voiceModel')}</Label>
              <Input
                value={voice.model}
                onChange={(event) => patch({ voice: { ...voice, model: event.target.value } })}
                placeholder="whisper-1"
                aria-label={t('media.voiceModel')}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('settings.ai.apiKey')}</Label>
            <Input
              type="password"
              autoComplete="off"
              value={voice.apiKey}
              onChange={(event) => patch({ voice: { ...voice, apiKey: event.target.value } })}
              placeholder="sk-..."
              aria-label={`${t('au.title')} ${t('settings.ai.apiKey')}`}
            />
          </div>
        </div>
      </SettingSection>
    </SettingPage>
  )
}
