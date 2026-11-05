import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Check,
  Image as ImageIcon,
  Link2,
  ListTodo,
  Mic,
  Search,
  Sparkles,
  Square,
  SquareCheck,
  Tag,
  Trash2,
  Type,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { EmptyState, Spinner } from '@/components/ui/misc'
import { loadPreview, previewOf } from '@/lib/previewCache'
import { buildRecordsPrompt, finalizeOrganizedNote } from '@/lib/organizeRecords'
import { recognizeRecordImage } from '@/lib/screenshot'
import { cn, formatDateTime, relativeTime } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useRecordsStore, type TimeRange } from '@/stores/records'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { useNotesStore } from '@/stores/notes'
import { aiChat } from '@/lib/rpc'

type RecordType = 'text' | 'link' | 'todo' | 'image'
/** 新建记录时可选的类型（图片记录由截图工具产生，不在这里手填） */
const COMPOSE_TYPES: RecordType[] = ['text', 'link', 'todo']

/**
 * 记录类型元数据
 *
 * 配色对齐 NoteGen `mark-type-meta.ts`：文字=黄绿、链接=蓝、待办=灰。
 * 未启用的类型（图片 / 录音 / 扫描 / 文件）保留图标与色值，后续接入时直接复用。
 */
const TYPE_META: Record<RecordType, { icon: typeof Type; labelKey: string; chip: string; icon_: string }> = {
  text: {
    icon: Type,
    labelKey: 'records.type.text',
    chip: 'border-lime-300 bg-lime-50 text-lime-900 dark:border-lime-500/60 dark:bg-lime-500/18 dark:text-lime-200',
    icon_: 'text-lime-600 dark:text-lime-300',
  },
  link: {
    icon: Link2,
    labelKey: 'records.type.link',
    chip: 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-500/60 dark:bg-blue-500/18 dark:text-blue-200',
    icon_: 'text-blue-500 dark:text-blue-300',
  },
  image: {
    icon: ImageIcon,
    labelKey: 'records.type.image',
    chip:
      'border-purple-300 bg-purple-50 text-purple-900 dark:border-purple-500/60 dark:bg-purple-500/18 dark:text-purple-200',
    icon_: 'text-purple-500 dark:text-purple-300',
  },
  todo: {
    icon: ListTodo,
    labelKey: 'records.type.todo',
    chip:
      'border-slate-300 bg-slate-100 text-slate-900 dark:border-slate-400/60 dark:bg-slate-400/20 dark:text-slate-100',
    icon_: 'text-slate-500 dark:text-slate-300',
  },
}

const TYPES = Object.keys(TYPE_META) as RecordType[]

/**
 * 图片记录的缩略图
 *
 * 记录里存的是工作区相对路径，沙箱里 `<img src="相对路径">` 会 404，
 * 所以统一经 previewCache 换成 dataUrl 再渲染（与编辑器、画布节点一致）。
 */
function RecordImage({ src }: { src: string }) {
  const [url, setUrl] = useState<string | undefined>(() => previewOf(src))

  useEffect(() => {
    if (url) return
    let cancelled = false
    void loadPreview(src).then((value) => {
      if (!cancelled && value) setUrl(value)
    })
    return () => {
      cancelled = true
    }
  }, [src, url])

  if (!url) {
    return (
      <p className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
        {src.split('/').pop()}
      </p>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1" data-record-image>
      <img src={url} alt={src} className="max-h-40 rounded-md border border-border object-contain" />
    </a>
  )
}
const RANGES: TimeRange[] = ['all', 'today', 'last7Days', 'last30Days']

/**
 * 碎片记录面板
 *
 * 结构对齐 NoteGen 的「记录」页：
 * 顶部是快速记录（类型 + 标签 + 语音），下面是搜索 / 类型 / 时间 / 标签筛选，
 * 列表支持 todo 勾选完成、归档（回收站）、勾选多条交给 AI 整理成笔记。
 */
export function RecordPanel() {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const ai = useSettingsStore((state) => state.ai)
  const openSettings = useUiStore((state) => state.openSettings)
  const setVoiceOpen = useUiStore((state) => state.setVoiceOpen)

  const items = useRecordsStore((state) => state.items)
  const tags = useRecordsStore((state) => state.tags)
  const filter = useRecordsStore((state) => state.filter)
  const selected = useRecordsStore((state) => state.selected)
  const loading = useRecordsStore((state) => state.loading)
  const add = useRecordsStore((state) => state.add)
  const remove = useRecordsStore((state) => state.remove)
  const archive = useRecordsStore((state) => state.archive)
  const restore = useRecordsStore((state) => state.restore)
  const toggleTodo = useRecordsStore((state) => state.toggleTodo)
  const toggleSelect = useRecordsStore((state) => state.toggleSelect)
  const clearSelection = useRecordsStore((state) => state.clearSelection)
  const setFilter = useRecordsStore((state) => state.setFilter)
  const selectedRecords = useRecordsStore((state) => state.selectedRecords)

  const recordSettings = useSettingsStore((state) => state.record)
  const promptSettings = useSettingsStore((state) => state.prompt)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [type, setType] = useState<RecordType>(recordSettings.defaultType)
  const [draft, setDraft] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [pendingTags, setPendingTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [organizing, setOrganizing] = useState(false)

  const trashed = filter.trashed

  /** 按「设置 → 记录」的排序规则展示列表 */
  const visibleItems = useMemo(() => {
    const list = [...items]
    if (recordSettings.sort === 'oldest') list.sort((a, b) => a.createdAt - b.createdAt)
    else if (recordSettings.sort === 'type')
      list.sort((a, b) => a.type.localeCompare(b.type) || b.createdAt - a.createdAt)
    else list.sort((a, b) => b.createdAt - a.createdAt)
    return list
  }, [items, recordSettings.sort])

  const placeholder = useMemo(() => {
    if (type === 'link') return locale.startsWith('zh') ? '粘贴一个链接…' : 'Paste a link…'
    if (type === 'todo') return locale.startsWith('zh') ? '要做什么？…' : 'What needs doing?…'
    return t('records.placeholder')
  }, [locale, t, type])

  const submit = async () => {
    if (!draft.trim() || busy) return
    setBusy(true)
    try {
      await add(draft, type, pendingTags)
      setDraft('')
      setPendingTags([])
      toast.success(t('records.created'))
      // 「保存后聚焦输入框」开启时直接继续录入
      if (recordSettings.focusAfterSaved) inputRef.current?.focus()
    } catch (error) {
      toast.error(t('toast.error', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const commitTag = () => {
    const name = tagInput.trim().replace(/^#/, '')
    if (!name) return
    if (!pendingTags.includes(name)) setPendingTags([...pendingTags, name])
    setTagInput('')
  }

  /** 选中的记录 → AI 整理 → 新建笔记 */
  const organize = async () => {
    const picked = selectedRecords()
    if (picked.length === 0) {
      toast.error(t('records.needSelection'))
      return
    }
    if (!ai.baseUrl || !ai.model) {
      openSettings('ai')
      return
    }
    setOrganizing(true)
    try {
      // 按时间排序后交给提示词拼装：图片记录会给 `Image URL`，并保留每条的原始时间
      const ordered = picked.slice().sort((left, right) => left.createdAt - right.createdAt)
      const prompt = buildRecordsPrompt(ordered)

      const response = await aiChat({
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey,
        model: ai.model,
        temperature: ai.temperature,
        messages: [
          {
            role: 'system',
            // 整理提示词取自「设置 → 提示词」，留空时用内置默认
            content: [
              promptSettings.organize.trim() ||
                (locale.startsWith('zh')
                  ? '你是笔记整理助手。把零散记录整理成结构清晰的 Markdown 笔记，包含标题、小节与要点，保留原始事实，不要编造。'
                  : 'You organize scattered notes into a clear Markdown note with headings and bullets. Keep facts, do not invent.'),
              // 输出约束：只要 Markdown 正文，图片必须原样落进正文
              locale.startsWith('zh')
                ? '只输出 Markdown 正文，不要用 ``` 代码块把整篇包起来；有图片记录时必须把 `Image URL` 原样写成 `![描述](地址)` 放进正文。'
                : 'Return the Markdown body only — never wrap the whole note in a ``` code fence. When image records exist, embed each `Image URL` verbatim as `![description](url)`.',
            ].join('\n\n'),
          },
          { role: 'user', content: `${t('chat.recordsContext')}\n\n${prompt.text}` },
        ],
        timeoutMs: 180_000,
      })

      const content = finalizeOrganizedNote(response.content, prompt.images, {
        attachmentHeading: locale.startsWith('zh') ? '附图' : 'Images',
      })
      const title = `${locale.startsWith('zh') ? '记录整理' : 'Organized notes'} ${formatDateTime(Date.now())}`
      await useNotesStore.getState().create('file', '', title.replace(/[:]/g, '-'))
      useNotesStore.getState().setContent(content)
      await useNotesStore.getState().save({ force: true })
      clearSelection()
      toast.success(t('files.created'))
    } catch (error) {
      toast.error(t('toast.error', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setOrganizing(false)
    }
  }

  const toggleType = (value: RecordType) => {
    const next = filter.types.includes(value)
      ? filter.types.filter((item) => item !== value)
      : [...filter.types, value]
    setFilter({ types: next })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 快速记录 */}
      <div className="shrink-0 space-y-1.5 border-b border-border px-2 pb-2">
        <div className="flex items-center gap-1">
          {COMPOSE_TYPES.map((value) => {
            const meta = TYPE_META[value]
            const Icon = meta.icon
            return (
              <button
                key={value}
                type="button"
                onClick={() => setType(value)}
                className={cn(
                  'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
                  type === value
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className={cn('size-3', type === value ? undefined : meta.icon_)} />
                {t(meta.labelKey)}
              </button>
            )
          })}
          <div className="flex-1" />
          {pendingTags.map((name) => (
            <span key={name} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              #{name}
            </span>
          ))}
        </div>

        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={placeholder}
          rows={3}
          className="w-full resize-none rounded-lg border border-border/70 bg-muted/20 px-2.5 py-2 text-[13px] leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring/40 focus:bg-background"
        />

        <div className="flex items-center gap-1.5">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Tag className="pointer-events-none absolute left-1.5 size-3 text-muted-foreground" />
            <input
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitTag()
                }
                if (event.key === 'Backspace' && !tagInput && pendingTags.length > 0) {
                  setPendingTags(pendingTags.slice(0, -1))
                }
              }}
              placeholder={t('records.tagPlaceholder')}
              className="h-7 w-full rounded-md border border-transparent bg-muted/40 pr-1.5 pl-6 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-border focus:bg-background"
            />
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('voice.title')}
            title={t('voice.title')}
            className="h-7 shrink-0"
            onClick={() => setVoiceOpen(true)}
          >
            <Mic className="size-3.5" />
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!draft.trim() || busy} className="h-7 shrink-0">
            {busy ? <Spinner className="text-primary-foreground" /> : <Check className="size-3.5" />}
            {t('records.add')}
          </Button>
        </div>
      </div>

      {/* 搜索 + 类型 + 时间 + 标签：对齐参考实现顶部筛选区 */}
      <div className="shrink-0 space-y-1.5 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Search className="pointer-events-none absolute left-1.5 size-3 text-muted-foreground" />
            <input
              value={filter.query}
              onChange={(event) => setFilter({ query: event.target.value })}
              placeholder={t('records.searchPlaceholder')}
              aria-label={t('records.searchPlaceholder')}
              className="h-7 w-full rounded-md border border-border/70 bg-muted/30 pr-1.5 pl-6 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-ring/40 focus:bg-background"
            />
          </div>
          <button
            type="button"
            aria-label={trashed ? t('records.backToList') : t('records.trash')}
            title={trashed ? t('records.backToList') : t('records.trash')}
            onClick={() => {
              clearSelection()
              setFilter({ trashed: !trashed })
            }}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
              trashed
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {trashed ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </button>
        </div>

        <div className="scrollbar-hide flex items-center gap-1 overflow-x-auto">
          <FilterChip active={filter.types.length === 0} onClick={() => setFilter({ types: [] })}>
            {t('records.allTypes')}
          </FilterChip>
          {TYPES.map((value) => {
            const meta = TYPE_META[value]
            const active = filter.types.includes(value)
            const Icon = meta.icon
            return (
              <FilterChip
                key={value}
                active={active}
                onClick={() => toggleType(value)}
                activeClassName={meta.chip}
              >
                <Icon className={cn('mr-1 size-3', meta.icon_)} />
                {t(meta.labelKey)}
              </FilterChip>
            )
          })}
        </div>

        <div className="scrollbar-hide flex items-center gap-1 overflow-x-auto">
          {RANGES.map((range) => (
            <FilterChip key={range} active={filter.range === range} onClick={() => setFilter({ range })}>
              {t(`records.time.${range}`)}
            </FilterChip>
          ))}
        </div>

        <div className="scrollbar-hide flex items-center gap-1 overflow-x-auto">
          <FilterChip active={!filter.tagId} onClick={() => setFilter({ tagId: '' })}>
            {t('records.allTags')}
          </FilterChip>
          {tags.map((tag) => (
            <FilterChip
              key={tag.id}
              active={filter.tagId === tag.id}
              onClick={() => setFilter({ tagId: filter.tagId === tag.id ? '' : tag.id })}
            >
              #{tag.name}
              <span className="ml-1 text-[10px] text-muted-foreground">{tag.count}</span>
            </FilterChip>
          ))}
        </div>
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-6">
            <Spinner className="text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={trashed ? t('records.trashEmpty') : t('records.empty')}
            description={trashed ? t('records.trashHint') : t('records.emptyHint')}
          />
        ) : (
          <div className={cn('gap-1.5', recordSettings.view === 'cards' ? 'grid grid-cols-2' : 'space-y-1.5')}>
            {visibleItems.map((item) => {
              const active = selected.includes(item.id)
              const done = Boolean(item.meta?.done)
              const meta = TYPE_META[item.type as RecordType]
              // 截图存进记录后由识别模型补的解读文字
              const insight = typeof item.meta?.text === 'string' ? item.meta.text.trim() : ''
              // 双通道都没读到内容才标记失败（meta.method === 'none'）
              const insightFailed = item.type === 'image' && item.meta?.method === 'none'
              return (
                <div
                  key={item.id}
                  data-record={item.id}
                  className={cn(
                    'group relative rounded-lg border transition-colors',
                    recordSettings.view === 'compact' ? 'px-1.5 py-1' : 'px-2 py-1.5',
                    active
                      ? 'border-primary/40 bg-primary/[0.04]'
                      : 'border-border/60 hover:border-border hover:bg-muted/30',
                  )}
                >
                  <div className="flex items-start gap-1.5">
                    <button
                      type="button"
                      onClick={() => toggleSelect(item.id)}
                      className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={t('records.selection', { count: selected.length })}
                    >
                      {active ? (
                        <SquareCheck className="size-3.5 text-primary" />
                      ) : (
                        <Square className="size-3.5" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-1.5">
                        {/* todo 记录可直接勾选完成，与参考实现一致 */}
                        {item.type === 'todo' ? (
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={done}
                            aria-label={t('records.todoDone')}
                            onClick={() => {
                              void toggleTodo(item.id, !done).catch((error: unknown) => {
                                toast.error(
                                  t('toast.error', {
                                    message: error instanceof Error ? error.message : String(error),
                                  }),
                                )
                              })
                            }}
                            className="mt-0.5 shrink-0"
                          >
                            {done ? (
                              <SquareCheck className="size-3.5 text-primary" />
                            ) : (
                              <Square className="size-3.5 text-muted-foreground" />
                            )}
                          </button>
                        ) : null}
                        {item.type === 'image' ? (
                          <div className="min-w-0 flex-1 space-y-1">
                            <RecordImage src={item.content} />
                            {insight ? (
                              <p
                                data-record-insight
                                className={cn(
                                  'line-clamp-3 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed',
                                  insightFailed ? 'text-destructive/80' : 'text-muted-foreground',
                                )}
                              >
                                {insight}
                              </p>
                            ) : null}
                            {insightFailed ? (
                              <button
                                type="button"
                                data-record-retry
                                title={
                                  typeof item.meta?.error === 'string' && item.meta.error
                                    ? item.meta.error
                                    : undefined
                                }
                                onClick={() => {
                                  void recognizeRecordImage(item.id, item.content).catch(
                                    (error: unknown) => {
                                      toast.error(
                                        t('toast.error', {
                                          message:
                                            error instanceof Error ? error.message : String(error),
                                        }),
                                      )
                                    },
                                  )
                                }}
                                className="text-[11px] font-medium text-primary hover:underline"
                              >
                                {t('common.retry')}
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          <p
                            className={cn(
                              'min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed',
                              done && 'text-muted-foreground line-through',
                            )}
                          >
                            {item.content}
                          </p>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                        <span>{relativeTime(item.createdAt, locale)}</span>
                        {item.type !== 'text' && meta ? (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium',
                              meta.chip,
                            )}
                          >
                            {t(meta.labelKey)}
                          </span>
                        ) : null}
                        {item.tags.map((tag) => (
                          <span key={tag.id} className="rounded bg-muted px-1 py-0.5">
                            #{tag.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      {trashed ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void restore(item.id)}
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            title={t('records.restore')}
                            aria-label={t('records.restore')}
                          >
                            <ArchiveRestore className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(item.id)}
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title={t('records.deleteForever')}
                            aria-label={t('records.deleteForever')}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => void archive(item.id)}
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            title={t('records.archive')}
                            aria-label={t('records.archive')}
                          >
                            <Archive className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(item.id)}
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 选择操作条 */}
      {selected.length > 0 ? (
        <div className="animate-slide-in shrink-0 border-t border-border bg-muted/30 px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t('records.selection', { count: selected.length })}</span>
            <button type="button" onClick={clearSelection} className="hover:text-foreground">
              {t('records.clearSelection')}
            </button>
          </div>
          <Button size="sm" className="w-full" onClick={() => void organize()} disabled={organizing || trashed}>
            {organizing ? <Spinner className="text-primary-foreground" /> : <Sparkles className="size-3.5" />}
            {t('records.toNote')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  activeClassName,
  children,
}: {
  active: boolean
  onClick: () => void
  /** 类型筛选用各自的色板，未传时用主色淡底 */
  activeClassName?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11px] transition-colors',
        active
          ? activeClassName ?? 'border-primary/40 bg-primary/10 font-medium text-foreground'
          : 'border-border/70 text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
