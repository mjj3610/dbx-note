/**
 * 选区 AI 结果面板
 *
 * 流式文本先在这里预览，「替换选区 / 插入到下方」才写回正文——
 * 参考实现是边流式边替换，插件里改成「先预览后应用」：
 * TipTap 每帧重写选区会让文档频繁重建（长选区尤其卡），而且误触后无法预判结果。
 * 取消会调 `ai/cancel` 停掉后端流，不留悬挂请求。
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { Loader2, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'

import { useSelectionAIStore } from '@/stores/selectionAI'
import { useUiStore } from '@/stores/ui'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/useT'

const PANEL_WIDTH = 340
const PANEL_HEIGHT = 240

const ACTION_KEY: Record<string, string> = {
  polish: 'editor.ai.polish',
  concise: 'editor.ai.concise',
  expand: 'editor.ai.expand',
  translate: 'editor.ai.translate',
}

export function SelectionAIPanel({ editor }: { editor: Editor }) {
  const t = useT()
  const request = useSelectionAIStore((state) => state.request)
  const output = useSelectionAIStore((state) => state.output)
  const streaming = useSelectionAIStore((state) => state.streaming)
  const error = useSelectionAIStore((state) => state.error)
  const close = useSelectionAIStore((state) => state.close)
  const apply = useSelectionAIStore((state) => state.apply)
  const openSettings = useUiStore((state) => state.openSettings)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // 流式追到底部，长文本也能一直看到最新内容
  useEffect(() => {
    const node = bodyRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [output])

  if (!request) return null

  const top = Math.max(
    8,
    Math.min(request.anchor.top, window.innerHeight - PANEL_HEIGHT - 8),
  )
  const left = Math.max(
    8,
    Math.min(request.anchor.left, window.innerWidth - PANEL_WIDTH - 8),
  )

  const write = (mode: 'replace' | 'insert') => {
    const ok = apply(editor, mode)
    if (ok) toast.success(t(mode === 'replace' ? 'editor.ai.replaced' : 'editor.ai.inserted'))
  }

  const title = t(ACTION_KEY[request.action] ?? 'editor.ai.title')

  return createPortal(
    <div
      data-selection-ai-panel
      role="dialog"
      aria-label={title}
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
      style={{ top, left, width: PANEL_WIDTH, maxHeight: PANEL_HEIGHT }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-1.5">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        {streaming ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
        <Button variant="ghost" size="icon-sm" aria-label={t('common.close')} onClick={close}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div
        ref={bodyRef}
        data-selection-ai-output
        className="min-h-16 flex-1 overflow-y-auto px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap"
      >
        {error === 'no-model' ? (
          <div className="space-y-2 text-muted-foreground">
            <p>{t('editor.ai.noModel')}</p>
            <Button size="xs" variant="outline" onClick={() => openSettings('ai')}>
              {t('editor.ai.openSettings')}
            </Button>
          </div>
        ) : error ? (
          <span className="text-destructive">{error}</span>
        ) : output ? (
          output
        ) : (
          <span className="text-muted-foreground">{t('editor.ai.thinking')}</span>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border px-2 py-1.5">
        <Button variant="ghost" size="xs" onClick={close}>
          {t('common.cancel')}
        </Button>
        <Button variant="outline" size="xs" disabled={!output || streaming} onClick={() => write('insert')}>
          {t('editor.ai.insertBelow')}
        </Button>
        <Button size="xs" disabled={!output || streaming} onClick={() => write('replace')}>
          {t('editor.ai.replace')}
        </Button>
      </div>
    </div>,
    document.body,
  )
}
