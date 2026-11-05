import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FileText, Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { Spinner } from '@/components/ui/misc'
import * as rpc from '@/lib/rpc'
import { flattenFiles } from '@/lib/tree'
import { baseName, cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { flushPendingSave, useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'
import { MarkdownEditor } from './MarkdownEditor'

/** 自动保存防抖（毫秒） */
const SAVE_DEBOUNCE = 800

/**
 * 并排对照面板
 *
 * 与主编辑区独立：自己读写文件、自己保存，互不干扰，
 * 用于「一边写一边对照另一篇笔记」的场景（NoteGen 的分屏对照）。
 */
export function SidePane() {
  const t = useT()
  const path = useUiStore((state) => state.sidePane)
  const setSidePane = useUiStore((state) => state.setSidePane)
  const tree = useNotesStore((state) => state.tree)

  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [state2, setState2] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const loadedFor = useRef('')

  // 切换文件时读盘；同一文件不重复读取，避免覆盖正在输入的内容
  useEffect(() => {
    if (!path || loadedFor.current === path) return
    loadedFor.current = path
    setLoading(true)
    setError('')
    rpc
      .readFile(path)
      .then((file) => {
        setContent(file.content)
        setState2('idle')
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false))
  }, [path])

  // 卸载时把未落盘的内容 flush 掉
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  const syncWrite = useMemo(
    () => (next: string) => {
      if (!path) return
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        setState2('saving')
        rpc
          .writeFile(path, next)
          .then(() => setState2('saved'))
          .catch((cause) => {
            setState2('error')
            setError(cause instanceof Error ? cause.message : String(cause))
          })
      }, SAVE_DEBOUNCE)
    },
    [path],
  )

  const files = useMemo(() => flattenFiles(tree), [tree])

  if (!path) return null

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-side-path={path}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] font-medium transition-colors hover:bg-muted"
              title={path}
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{baseName(path)}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
            <DropdownMenuLabel>{t('side.choose')}</DropdownMenuLabel>
            {files.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t('common.empty')}</div>
            ) : (
              files.map((file) => (
                <DropdownMenuItem key={file.path} onSelect={() => setSidePane(file.path)}>
                  <FileText className="size-3.5" />
                  <span className="truncate">{file.path}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="shrink-0 text-[11px] text-muted-foreground">
          {state2 === 'saving' ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              {t('editor.saving')}
            </span>
          ) : state2 === 'saved' ? (
            t('editor.saved')
          ) : state2 === 'error' ? (
            <span className="text-destructive">{t('editor.unsaved')}</span>
          ) : null}
        </span>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('side.close')}
          onClick={() => {
            if (timer.current) window.clearTimeout(timer.current)
            loadedFor.current = ''
            setSidePane(null)
            // 主编辑区若有未落盘内容，一并刷盘，避免切换错觉
            void flushPendingSave()
          }}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className={cn('relative min-h-0 flex-1 overflow-hidden')}>
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="p-4 text-xs text-destructive">{error}</div>
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto w-full px-5 pt-4" style={{ maxWidth: 'var(--dbx-note-editor-width, 760px)' }}>
              <MarkdownEditor
                key={path}
                path={path}
                registerBus={false}
                value={content}
                onChange={(next) => {
                  setContent(next)
                  setState2('idle')
                  syncWrite(next)
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
