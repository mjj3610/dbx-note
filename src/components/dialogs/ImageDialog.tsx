import { useEffect, useState } from 'react'
import { Check, Copy, ImageOff, Loader2, ScanText, TextCursorInput } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { insertToEditor } from '@/lib/editorBus'
import { recognizeImage } from '@/lib/imageRecognition'
import * as rpc from '@/lib/rpc'
import { baseName, cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/**
 * 图片预览 + 文字识别
 *
 * 图片内容由 Sidecar 读成 data URL（宿主 CSP 下页面拿不到工作区文件路径）。
 * 若宿主连 `data:` 也禁掉，`<img>` 会触发 onError，此时降级为说明 + 复制路径，
 * 避免出现一片空白让人误以为文件坏了。
 *
 * 识别走 OpenAI 兼容的多模态接口：优先用「图片识别」的独立配置，
 * 未配置时回落到 AI 模型配置。
 */
export function ImageDialog() {
  const t = useT()
  const path = useUiStore((state) => state.imagePreview)
  const setPath = useUiStore((state) => state.setImagePreview)
  const ocr = useSettingsStore((state) => state.ocr)
  /** 图像识别总开关关闭时隐藏识别入口 */
  const ocrEnabled = useSettingsStore((state) => state.imageMethod.enabled)

  const [dataUrl, setDataUrl] = useState('')
  const [size, setSize] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!path) {
      setDataUrl('')
      setFailed('')
      setBlocked(false)
      setText('')
      return
    }
    let alive = true
    setLoading(true)
    setFailed('')
    setBlocked(false)
    setText('')
    rpc
      .readImage(path)
      .then((data) => {
        if (!alive) return
        setDataUrl(data.dataUrl)
        setSize(data.size)
      })
      .catch((error) => {
        if (!alive) return
        const message = error instanceof Error ? error.message : String(error)
        setFailed(message)
        toast.error(t('image.failed', { message }))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [path, t])

  const recognize = async () => {
    if (!path) return
    setRecognizing(true)
    try {
      // 双通道：视觉模型优先，返回空 / 报错自动回退系统 OCR
      const result = await recognizeImage({
        path,
        prompt: ocr.prompt.trim() || undefined,
        maxTokens: 120,
      })
      setText(result.content)
      if (!result.content) toast.warning(t('image.ocrEmpty'))
      else if (result.method === 'ocr') toast.info(t('image.usedOcr'))
    } catch (error) {
      toast.error(t('toast.error', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setRecognizing(false)
    }
  }

  return (
    <Dialog open={Boolean(path)} onOpenChange={(open) => (open ? undefined : setPath(null))}>
      <DialogContent className="max-w-3xl p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <DialogTitle className="min-w-0 truncate text-sm font-medium">
            {path ? baseName(path) : ''}
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-2">
            {size > 0 ? (
              <span className="text-[11px] text-muted-foreground">{formatSize(size)}</span>
            ) : null}
            {ocrEnabled ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!path || loading || recognizing}
              onClick={() => void recognize()}
            >
              {recognizing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ScanText className="size-3.5" />
              )}
              {recognizing ? t('image.ocrRunning') : t('image.ocr')}
            </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('image.copyPath')}
              onClick={() => {
                if (!path) return
                void navigator.clipboard
                  ?.writeText(path)
                  .then(() => toast.success(t('common.copied')))
                  .catch(() => toast.error(t('image.copyFailed')))
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex min-h-[220px] items-center justify-center bg-muted/30 p-4">
          {loading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : failed ? (
            <p className="px-4 text-center text-xs text-destructive">
              {t('image.failed', { message: failed })}
            </p>
          ) : blocked ? (
            <div className="max-w-md text-center">
              <ImageOff className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-2 text-xs font-medium">{t('image.blocked')}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t('image.blockedHint')}
              </p>
            </div>
          ) : dataUrl ? (
            <img
              src={dataUrl}
              alt={path ?? ''}
              className="max-h-[70vh] w-auto rounded-md object-contain"
              onError={() => setBlocked(true)}
            />
          ) : null}
        </div>

        {text ? (
          <div className="border-t border-border" data-ocr-result>
            <div className="flex items-center justify-between px-4 py-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t('image.ocr')}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(text)
                      .then(() => {
                        setCopied(true)
                        window.setTimeout(() => setCopied(false), 1500)
                      })
                      .catch(() => toast.error(t('image.copyFailed')))
                  }}
                >
                  {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                  {t('image.ocrCopy')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (!insertToEditor(text)) {
                      toast.error(t('editor.noFile'))
                      return
                    }
                    toast.success(t('image.ocrInserted'))
                  }}
                >
                  <TextCursorInput className="size-3.5" />
                  {t('image.ocrInsert')}
                </Button>
              </div>
            </div>
            <pre
              className={cn(
                'max-h-48 overflow-auto px-4 pb-3 text-[12px] leading-relaxed whitespace-pre-wrap',
                'text-foreground',
              )}
            >
              {text}
            </pre>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
