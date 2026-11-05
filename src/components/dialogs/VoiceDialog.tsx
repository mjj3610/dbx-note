import { useEffect, useRef, useState } from 'react'
import { CircleStop, FileAudio, Loader2, Mic, TextCursorInput } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { insertToEditor } from '@/lib/editorBus'
import * as rpc from '@/lib/rpc'
import { resolveModelWithFallback } from '@/lib/aiConfig'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/** 转写结果插入当前笔记 */

/**
 * 语音转写
 *
 * 两条入口，都不依赖宿主给 iframe 开麦克风权限：
 * 1. 录音：真正的采集在 Sidecar（系统麦克风 + cpal），前端只负责开始 / 结束与计时；
 * 2. 选择音频文件：随时可用的兜底路径。
 *
 * 音频不落盘，走 `ai/transcribe` 的 base64 分支直接上传；
 * 结果可以插入当前笔记，或存成一条记录。
 */
export function VoiceDialog() {
  const t = useT()
  const open = useUiStore((state) => state.voiceOpen)
  const setOpen = useUiStore((state) => state.setVoiceOpen)
  const voice = useSettingsStore((state) => state.voice)
  const ai = useSettingsStore((state) => state.ai)

  /** 录音状态：unknown=还没试过，requesting=正在启动，ready=在录，denied/no-device=系统侧不可用 */
  const [recordState, setRecordState] = useState<
    'unknown' | 'requesting' | 'ready' | 'denied' | 'no-device'
  >('unknown')
  const [dropping, setDropping] = useState(false)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [seconds, setSeconds] = useState(0)
  const timerRef = useRef<number | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  // 关闭面板时停掉计时，并把仍在进行的录音收尾（Sidecar 侧的采集也要停）
  useEffect(() => {
    if (open) return
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    setRecording(false)
    setSeconds(0)
    void rpc.recordStop().catch(() => undefined)
  }, [open])

  const stopTimer = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
  }

  const transcribe = async (params: { base64?: string; mime?: string; name?: string }) => {
    // 优先级：声音设置里的专用转写配置 → 「语音转写」用途的默认模型 → 内置 whisper-1
    const sttModel = resolveModelWithFallback(ai, 'stt')
    const baseUrl = voice.baseUrl.trim() || sttModel?.baseUrl || ''
    const apiKey = voice.apiKey.trim() || sttModel?.apiKey || ''
    const model = voice.model.trim() || sttModel?.modelName || 'whisper-1'
    if (!baseUrl) {
      toast.error(t('settings.ai.modelsEmpty'))
      return
    }
    setBusy(true)
    try {
      const result = await rpc.aiTranscribe({
        baseUrl,
        apiKey,
        model,
        audioBase64: params.base64,
        mime: params.mime,
        name: params.name,
      })
      const value = result.text.trim()
      setText(value)
      if (!value) toast.warning(t('voice.empty'))
    } catch (error) {
      toast.error(t('voice.failed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const startRecording = async () => {
    // 采集在 Sidecar 里做：宿主的 iframe 没有 allow="microphone"，
    // 浏览器侧 getUserMedia 在宿主里会一直挂着，所以不再走那条路。
    setRecordState('requesting')
    try {
      await rpc.recordStart()
      if (!openRef.current) {
        void rpc.recordStop().catch(() => undefined)
        return
      }
      setRecordState('ready')
      setRecording(true)
      setSeconds(0)
      stopTimer()
      timerRef.current = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    } catch (error) {
      if (!openRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      const missing = /麦克风|设备|device/i.test(message)
      setRecordState(missing ? 'no-device' : 'denied')
      toast.warning(t(missing ? 'voice.noDevice' : 'voice.recordDenied'))
    }
  }

  const stopRecording = async () => {
    stopTimer()
    setRecording(false)
    try {
      const audio = await rpc.recordStop()
      if (audio.durationMs < 600) {
        // 太短基本是误触，不再送转写
        setRecordState('ready')
        return
      }
      await transcribe({ base64: audio.dataBase64, mime: audio.mime, name: audio.name })
    } catch (error) {
      setRecordState('ready')
      toast.error(t('voice.failed', { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  const pickFile = async (file: File) => {
    const base64 = await blobToBase64(file)
    await transcribe({ base64, mime: file.type || 'audio/mpeg', name: file.name })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-sm font-medium">{t('voice.title')}</DialogTitle>

        <div
          className={cn('space-y-3 rounded-lg transition-shadow', dropping && 'ring-2 ring-primary/50')}
          onDragOver={(event) => {
            event.preventDefault()
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDropping(false)
            const file = event.dataTransfer.files?.[0]
            if (!file) return
            if (!file.type.startsWith('audio/')) {
              toast.warning(t('voice.audioOnly'))
              return
            }
            void pickFile(file)
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* 录音按钮始终可点：宿主是否给麦克风要等真的申请才知道 */}
            <Button
              size="sm"
              variant={recording ? 'destructive' : 'outline'}
              disabled={busy || recordState === 'requesting'}
              data-voice-record
              onClick={() => (recording ? void stopRecording() : void startRecording())}
            >
              {recording ? (
                <CircleStop className="size-3.5" />
              ) : recordState === 'requesting' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Mic className="size-3.5" />
              )}
              {recording
                ? t('voice.stop')
                : recordState === 'requesting'
                  ? t('voice.requesting')
                  : t('voice.record')}
              {recording ? (
                <span className="ml-1 tabular-nums text-[11px]">{formatSeconds(seconds)}</span>
              ) : null}
            </Button>

            <label
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[13px] transition-colors',
                'hover:bg-muted',
                busy ? 'pointer-events-none opacity-50' : '',
              )}
            >
              <FileAudio className="size-3.5" />
              {t('voice.pick')}
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void pickFile(file)
                }}
              />
            </label>

            {busy ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {t('voice.transcribing')}
              </span>
            ) : null}
          </div>

          {/* 宿主没给麦克风权限时给出可操作的替代路径，而不是一句「不支持」 */}
          {recordState === 'requesting' ? (
            <div
              data-voice-requesting
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground"
            >
              <Loader2 className="size-3 animate-spin" />
              {t('voice.requestingHint')}
            </div>
          ) : null}
          {recordState === 'denied' || recordState === 'no-device' ? (
            <div
              data-voice-notice
              className="rounded-lg border border-amber-300/60 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            >
              <p className="font-medium">
                {t(recordState === 'denied' ? 'voice.recordDenied' : 'voice.noDevice')}
              </p>
              <p className="mt-0.5 opacity-80">{t('voice.recordFallback')}</p>
            </div>
          ) : null}

          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('voice.title')}
            aria-label={t('voice.title')}
            data-voice-result
            className="min-h-32 w-full resize-none rounded-lg border border-border bg-transparent p-2 text-[13px] leading-relaxed outline-none focus:border-ring/60"
          />

          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!text.trim()}
              onClick={() => {
                if (!insertToEditor(text.trim())) {
                  toast.error(t('editor.noFile'))
                  return
                }
                toast.success(t('image.ocrInserted'))
                setOpen(false)
              }}
            >
              <TextCursorInput className="size-3.5" />
              {t('image.ocrInsert')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取音频失败'))
    reader.readAsDataURL(blob)
  })
}

function formatSeconds(value: number): string {
  const minute = Math.floor(value / 60)
  const second = value % 60
  return `${minute}:${String(second).padStart(2, '0')}`
}
