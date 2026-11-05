/**
 * 搜索 / 替换面板（对齐复刻项目的 search-replace-panel）
 *
 * Ctrl/⌘+F 打开，Esc 关闭；Enter 下一个命中、Shift+Enter 上一个。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { CaseSensitive, ChevronDown, ChevronUp, Replace, ReplaceAll, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import {
  clearSearch,
  readSearch,
  replaceAll,
  replaceCurrent,
  setSearchCaseSensitive,
  setSearchQuery,
  stepSearch,
} from '@/lib/searchReplace'

export function SearchReplacePanel({
  editor,
  open,
  onClose,
}: {
  editor: Editor
  open: boolean
  onClose: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [active, setActive] = useState(0)
  const [total, setTotal] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  /** 从插件里读回命中数量，保证与高亮装饰一致 */
  const sync = useCallback(() => {
    const state = readSearch(editor)
    setActive(state.matches.length === 0 ? 0 : Math.min(state.active, state.matches.length - 1))
    setTotal(state.matches.length)
  }, [editor])

  // 打开时把选中文本填进搜索框（和复刻项目一致）
  useEffect(() => {
    if (!open) return
    const { from, to } = editor.state.selection
    const picked = from !== to ? editor.state.doc.textBetween(from, to, ' ').trim() : ''
    const next = picked && !picked.includes('\n') ? picked : query
    setQuery(next)
    setSearchCaseSensitive(editor, caseSensitive)
    setSearchQuery(editor, next)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    sync()
    // 只在打开瞬间做一次回填
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) return
    clearSearch(editor)
    setQuery('')
    setReplacement('')
    setTotal(0)
    setActive(0)
  }, [editor, open])

  // 替换后焦点会回到编辑器，Esc 必须挂在 window 上才收得到
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, open])

  const handleQuery = (value: string) => {
    setQuery(value)
    setSearchQuery(editor, value)
    sync()
  }

  const step = (direction: 1 | -1) => {
    setActive(stepSearch(editor, direction))
    sync()
  }

  const onReplace = () => {
    if (replaceCurrent(editor, replacement)) sync()
  }

  const onReplaceAll = () => {
    replaceAll(editor, replacement)
    sync()
  }

  const counter = useMemo(() => {
    if (!query) return ''
    return total === 0 ? t('editor.search.noResult') : `${active + 1}/${total}`
  }, [active, query, t, total])

  if (!open) return null

  return (
    <div
      data-search-panel
      className="fixed top-20 left-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-border bg-background p-3 shadow-lg"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (event.key === 'Enter' && event.target === inputRef.current) {
          event.preventDefault()
          step(event.shiftKey ? -1 : 1)
        }
      }}
    >
      {/* 搜索行 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('editor.search.placeholder')}
            onChange={(event) => handleQuery(event.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background pr-16 pl-8 text-[13px] outline-none focus:border-ring/60"
          />
          <span className="absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums">
            {counter}
          </span>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('editor.search.prev')}
          title={t('editor.search.prev')}
          disabled={total === 0}
          onClick={() => step(-1)}
        >
          <ChevronUp className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('editor.search.next')}
          title={t('editor.search.next')}
          disabled={total === 0}
          onClick={() => step(1)}
        >
          <ChevronDown className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* 替换行 */}
      <div className="mt-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Replace className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={replacement}
            placeholder={t('editor.search.replacePlaceholder')}
            onChange={(event) => setReplacement(event.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background pr-2 pl-8 text-[13px] outline-none focus:border-ring/60"
          />
        </div>
        <Button size="sm" variant="outline" disabled={total === 0} onClick={onReplace}>
          <Replace className="size-3.5" />
          {t('editor.search.replace')}
        </Button>
        <Button size="sm" variant="outline" disabled={total === 0} onClick={onReplaceAll}>
          <ReplaceAll className="size-3.5" />
          {t('editor.search.replaceAll')}
        </Button>
      </div>

      {/* 选项 */}
      <div className="mt-2 flex items-center gap-2 pt-1">
        <button
          type="button"
          aria-pressed={caseSensitive}
          onClick={() => {
            const next = !caseSensitive
            setCaseSensitive(next)
            setSearchCaseSensitive(editor, next)
            sync()
          }}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] transition-colors',
            caseSensitive
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted/60',
          )}
        >
          <CaseSensitive className="size-3.5" />
          {t('editor.search.caseSensitive')}
        </button>
      </div>
    </div>
  )
}
