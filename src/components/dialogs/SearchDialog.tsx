import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Loader2, Search } from 'lucide-react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { searchFiles, type SearchHit } from '@/lib/rpc'
import { cn, debounce } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'

/**
 * 全局搜索：文件名 + 正文，键盘上下选择、回车打开
 */
export function SearchDialog() {
  const t = useT()
  const open = useUiStore((state) => state.searchOpen)
  const setOpen = useUiStore((state) => state.setSearchOpen)
  const openFile = useNotesStore((state) => state.open)

  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const runSearch = useMemo(
    () =>
      debounce(async (query: string) => {
        if (!query.trim()) {
          setItems([])
          setLoading(false)
          return
        }
        setLoading(true)
        try {
          const result = await searchFiles(query.trim())
          setItems(result.items)
          setCursor(0)
        } catch {
          setItems([])
        } finally {
          setLoading(false)
        }
      }, 220),
    [],
  )

  useEffect(() => {
    if (!open) {
      setKeyword('')
      setItems([])
      setCursor(0)
      return
    }
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  useEffect(() => {
    setLoading(Boolean(keyword.trim()))
    runSearch(keyword)
  }, [keyword, runSearch])

  const openHit = async (hit: SearchHit) => {
    setOpen(false)
    try {
      await openFile(hit.path)
    } catch (error) {
      console.error('[search] 打开失败', error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[15%] max-w-xl translate-y-0 gap-0 p-0" hideClose>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((value) => Math.min(value + 1, Math.max(items.length - 1, 0)))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((value) => Math.max(value - 1, 0))
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const hit = items[cursor]
                if (hit) void openHit(hit)
              }
            }}
            placeholder={t('search.placeholder')}
            className="h-7 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</span>
        </div>

        <div ref={listRef} className="max-h-[380px] min-h-[120px] overflow-y-auto p-1.5">
          {!keyword.trim() ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('search.hint')}</p>
          ) : items.length === 0 && !loading ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('search.empty')}</p>
          ) : (
            items.map((hit, index) => (
              <button
                key={hit.path}
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => void openHit(hit)}
                className={cn(
                  'mb-0.5 flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                  index === cursor ? 'bg-muted' : 'hover:bg-muted/60',
                )}
              >
                <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{hit.title}</span>
                    <span className="truncate text-[10px] text-muted-foreground">{hit.path}</span>
                  </div>
                  {hit.snippet ? (
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {hit.snippet}
                    </p>
                  ) : null}
                </div>
              </button>
            ))
          )}
        </div>

        {items.length > 0 ? (
          <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
            {t('search.results', { count: items.length })}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
