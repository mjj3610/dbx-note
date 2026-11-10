import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, FileText, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import {
  SLASH_GROUPS,
  SLASH_ITEMS,
  itemHint,
  itemText,
  matchItems,
  runSlashCommand,
  type SlashGroup,
} from '@/lib/slashCommands'
import { flattenFiles, relativeLink } from '@/lib/tree'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'
import { useNotesStore } from '@/stores/notes'

/** 面板尺寸（用于边界收敛） */
const PANEL_WIDTH = 430
const PANEL_HEIGHT = 300

/**
 * 斜杠触发规则（与参考项目 `findSlashMatch` 一致）
 *
 * `/` 位于块首、空白或中英文标点之后即可触发，不要求整段只有一个 `/`。
 * 所以「1. 计算均值（数学期望）： /」这类已有正文的列表项也能带出面板；
 * 而 `abc/`（紧跟字母）与 Markdown 链接地址里的 `/` 不会误触发。
 * query 允许字母/数字/中文，但不含空格与第二个 `/`。
 */
const SLASH_TRIGGER_RE = /(?:^|[\s([{'"`<>]|[.,!?;:，。！？；：（）【】《》、])\/([^\s/]*)$/u
/** Markdown 链接 / 图片的目标地址里不触发，避免和文件路径推荐冲突 */
const LINK_TARGET_RE = /\[[^\]\n]+\]\([^)\n]*$/

interface Anchor {
  top: number
  left: number
}

/**
 * 斜杠命令面板
 *
 * 在块首或空白/标点之后输入 `/` 打开：左栏分类、右栏命令，
 * `↑↓` 选项、`←→` 切分类、`Enter` 执行、`Esc` 关闭。
 * 选中 AI 类命令时面板切换为「输入指令」态。
 */
export function SlashMenu({ editor }: { editor: Editor | null }) {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const zh = locale.startsWith('zh')

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [range, setRange] = useState({ from: 0, to: 0 })
  const [anchor, setAnchor] = useState<Anchor>({ top: 0, left: 0 })
  const [activeGroup, setActiveGroup] = useState<SlashGroup>('ai')
  const [cursor, setCursor] = useState(0)
  const [customMode, setCustomMode] = useState(false)
  // 「文件」命令的二级面板：列出工作区笔记，选中后插入相对链接
  const [fileMode, setFileMode] = useState(false)
  const [fileQuery, setFileQuery] = useState('')
  const fileModeRef = useRef(false)
  const tree = useNotesStore((state) => state.tree)
  const activePath = useNotesStore((state) => state.activePath)
  const [customPrompt, setCustomPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 左栏每个分组按钮，切分类时滚进可视区 */
  const groupRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const searched = useMemo(() => matchItems(query), [query])
  const items = useMemo(() => {
    const source = query.trim() ? searched : SLASH_ITEMS.filter((item) => item.group === activeGroup)
    return source
  }, [activeGroup, query, searched])

  /** 关闭并清掉行首的 `/query` */
  const close = useCallback((removeSlash: boolean) => {
    if (removeSlash && editor) {
      const { from, to } = range
      if (to > from) editor.chain().focus().deleteRange({ from, to }).run()
    }
    setOpen(false)
    setCustomMode(false)
    setCustomPrompt('')
    setFileMode(false)
    fileModeRef.current = false
    setFileQuery('')
    setQuery('')
    setBusy(false)
  }, [editor, range])

  // 监听编辑器：光标前最近的 `/`（块首或空白/标点之后）即触发，与参考实现一致
  useEffect(() => {
    if (!editor) return
    const sync = () => {
      // 只读模式与中文输入法组字期间保持现状，避免面板闪退
      if (!editor.isEditable || editor.view.composing) return
      const { state } = editor
      const { $from } = state.selection
      if (!$from.parent.isTextblock) {
        setOpen(false)
        return
      }
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
      if (!textBefore || LINK_TARGET_RE.test(textBefore)) {
        if (!fileModeRef.current) setOpen(false)
        return
      }
      const match = SLASH_TRIGGER_RE.exec(textBefore)
      if (!match || busy) {
        // 文件面板已经脱离斜杠输入，删除 `/文件` 后不应被这里关掉
        if (!match && !fileModeRef.current) setOpen(false)
        return
      }
      // 删除范围只覆盖 `/query`，不能把 `/` 前面的正文一起删掉
      const fullMatch = match[0]
      const slashOffset = textBefore.length - fullMatch.length + fullMatch.lastIndexOf('/')
      const from = $from.start() + slashOffset
      const to = $from.pos
      const coords = editor.view.coordsAtPos($from.pos)
      const top = Math.min(coords.bottom + 6, window.innerHeight - PANEL_HEIGHT - 12)
      const left = Math.min(coords.left, window.innerWidth - PANEL_WIDTH - 12)
      setRange({ from, to })
      setAnchor({ top: Math.max(12, top), left: Math.max(12, left) })
      setQuery(match[1] ?? '')
      setOpen(true)
      setCursor(0)
    }
    editor.on('update', sync)
    editor.on('selectionUpdate', sync)
    return () => {
      editor.off('update', sync)
      editor.off('selectionUpdate', sync)
    }
  }, [busy, editor])

  // 切分类时保证该分组在左栏可视区内（分组多于一屏时才有实际作用）
  useEffect(() => {
    const node = groupRefs.current[activeGroup]
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeGroup])

  // 选中项滚入可视区
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [cursor, items.length])

  /** 工作区里的笔记文件，供「文件」命令挑选 */
  const files = useMemo(() => flattenFiles(tree), [tree])
  const fileMatches = useMemo(() => {
    const keyword = fileQuery.trim().toLowerCase()
    if (!keyword) return files
    return files.filter(
      (file) => file.name.toLowerCase().includes(keyword) || file.path.toLowerCase().includes(keyword),
    )
  }, [fileQuery, files])

  /** 插入指向工作区文件的相对链接 */
  const pickFile = useCallback(
    (path: string, name: string) => {
      if (!editor) return
      const href = relativeLink(activePath, path)
      editor
        .chain()
        .focus()
        .insertContent(`[${name}](${href})`, { contentType: 'markdown' })
        .run()
      setFileMode(false)
      fileModeRef.current = false
      setFileQuery('')
      setOpen(false)
    },
    [activePath, editor],
  )

  const execute = useCallback(
    async (itemId: string) => {
      if (!editor) return
      if (itemId === 'ai.custom' && !customMode) {
        setCustomMode(true)
        return
      }
      if (itemId === 'block.file') {
        // 先置位再删 `/文件`：删除会同步触发 update，同步器看到没有斜杠会关面板
        fileModeRef.current = true
        setFileMode(true)
        setFileQuery('')
        setCursor(0)
        const { from, to } = range
        if (to > from) editor.chain().focus().deleteRange({ from, to }).run()
        setOpen(true)
        return
      }
      // 先删掉 `/query`，再执行命令（AI 命令耗时较长，先给反馈）
      const { from, to } = range
      if (to > from) editor.chain().focus().deleteRange({ from, to }).run()
      setOpen(false)
      const isAi = itemId.startsWith('ai.')
      setBusy(isAi)
      const toastId = isAi
        ? toast.loading(zh ? 'AI 生成中…' : 'Generating…', { duration: 120_000 })
        : undefined
      try {
        await runSlashCommand(itemId, editor, {
          customPrompt: customMode ? customPrompt : undefined,
        })
        if (toastId !== undefined) toast.success(zh ? '已插入' : 'Inserted', { id: toastId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (toastId !== undefined) toast.error(message, { id: toastId })
        else toast.error(message)
      } finally {
        setBusy(false)
        setCustomMode(false)
        setCustomPrompt('')
        setQuery('')
      }
    },
    [customMode, customPrompt, editor, range, zh],
  )

  // 键盘：面板打开时拦截方向键 / 回车 / Esc
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        // Esc 取消命令：连行首的 `/query` 一起清掉，避免留下孤立斜杠
        close(true)
        return
      }
      if (fileMode) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          event.stopPropagation()
          setCursor((current) => (fileMatches.length === 0 ? 0 : (current + 1) % fileMatches.length))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          setCursor((current) =>
            fileMatches.length === 0 ? 0 : (current - 1 + fileMatches.length) % fileMatches.length,
          )
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          const target = fileMatches[cursor]
          if (target) pickFile(target.path, target.name)
          return
        }
        return
      }
      if (customMode) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          event.stopPropagation()
          void execute('ai.custom')
        }
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setCursor((current) => (items.length === 0 ? 0 : (current + 1) % items.length))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setCursor((current) => (items.length === 0 ? 0 : (current - 1 + items.length) % items.length))
        return
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        // 只在没有搜索词时用于切分类，避免抢走输入框里的横向移动
        if (query.trim()) return
        event.preventDefault()
        event.stopPropagation()
        const index = SLASH_GROUPS.indexOf(activeGroup)
        const step = event.key === 'ArrowRight' ? 1 : -1
        const next = SLASH_GROUPS[(index + step + SLASH_GROUPS.length) % SLASH_GROUPS.length]
        setActiveGroup(next)
        setCursor(0)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        const item = items[cursor]
        if (item) void execute(item.id)
        else close(true)
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [activeGroup, close, cursor, customMode, execute, fileMatches, fileMode, items, open, pickFile, query])

  if (!open) return null

  const groupCount = (group: SlashGroup) => SLASH_ITEMS.filter((item) => item.group === group).length

  return (
    <div
      data-slash-menu
      role="listbox"
      aria-label={t('slash.title')}
      className="fixed z-50 flex overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
      style={{ top: anchor.top, left: anchor.left, width: PANEL_WIDTH, height: PANEL_HEIGHT }}
    >
      {/* 左：分类 */}
      <div className="flex w-[46%] min-w-0 flex-col border-r border-border bg-muted/30">
        {/* 分组全部列出（一屏放不下时左栏自己滚动），与参考实现一致 */}
        <div className="flex h-11 shrink-0 items-center justify-between px-3">
          <span className="text-[11px] font-medium text-muted-foreground">{t('slash.groups')}</span>
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <ArrowLeft className="size-3" />
            <ArrowRight className="size-3" />
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {SLASH_GROUPS.map((group) => {
            const active = !query.trim() && activeGroup === group
            return (
              <button
                key={group}
                type="button"
                ref={(element) => {
                  groupRefs.current[group] = element
                }}
                onClick={() => {
                  setActiveGroup(group)
                  setQuery('')
                  setCursor(0)
                }}
                className={cn(
                  'flex h-9 w-full items-center justify-between rounded-md px-2 text-[13px] transition-colors',
                  active
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                )}
              >
                <span className="truncate">{t(`slash.group.${group}`)}</span>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {groupCount(group)}
                  {active ? <ArrowRight className="size-3" /> : null}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 右：命令 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between px-3">
          <span className="truncate text-[11px] font-medium text-muted-foreground">
            {fileMode
              ? t('slash.fileTitle')
              : customMode
              ? t('slash.customTitle')
              : query.trim()
                ? t('slash.searching', { query: query.trim() })
                : t(`slash.group.${activeGroup}`)}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t('slash.scrollUp')}
              onClick={() => setCursor((current) => (items.length === 0 ? 0 : (current - 1 + items.length) % items.length))}
              className="flex size-6 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted"
            >
              <ArrowUp className="size-3" />
            </button>
            <button
              type="button"
              aria-label={t('slash.scrollDown')}
              onClick={() => setCursor((current) => (items.length === 0 ? 0 : (current + 1) % items.length))}
              className="flex size-6 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted"
            >
              <ArrowDown className="size-3" />
            </button>
          </div>
        </div>

        {fileMode ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
            <input
              autoFocus
              value={fileQuery}
              onChange={(event) => {
                setFileQuery(event.target.value)
                setCursor(0)
              }}
              placeholder={t('slash.filePlaceholder')}
              aria-label={t('slash.filePlaceholder')}
              className="h-8 shrink-0 rounded-lg border border-border bg-background px-2 text-[12px] outline-none focus:border-ring/60"
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {fileMatches.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground">
                  <FileText className="size-4" />
                  {t('slash.noFiles')}
                </div>
              ) : (
                fileMatches.map((file, index) => (
                  <button
                    key={file.path}
                    type="button"
                    data-index={index}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => pickFile(file.path, file.name)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                      index === cursor ? 'bg-muted' : 'hover:bg-muted/60',
                    )}
                  >
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{file.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{file.path}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : customMode ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
            <textarea
              autoFocus
              value={customPrompt}
              onChange={(event) => setCustomPrompt(event.target.value)}
              placeholder={t('slash.customPlaceholder')}
              aria-label={t('slash.customPlaceholder')}
              className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-background p-2 text-[13px] outline-none focus:border-ring/60"
            />
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setCustomMode(false)}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!customPrompt.trim()}
                onClick={() => void execute('ai.custom')}
                className="flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : null}
                {t('slash.execute')}
              </button>
            </div>
          </div>
        ) : (
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground">
                <Search className="size-4" />
                {t('slash.empty')}
              </div>
            ) : (
              items.map((item, index) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-index={index}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => void execute(item.id)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                      index === cursor ? 'bg-muted' : 'hover:bg-muted/60',
                    )}
                  >
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-background text-muted-foreground">
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{itemText(item, zh)}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {itemHint(item, zh)}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}
