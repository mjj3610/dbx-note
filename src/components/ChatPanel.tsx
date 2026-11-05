import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  Copy,
  CornerDownLeft,
  Library,
  MessageSquarePlus,
  MoreVertical,
  Square,
  Sparkles,
  Wand2,
  Wrench,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/misc'
import { Hint } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { copyText } from '@/lib/bridge'
import { insertToEditor } from '@/lib/editorBus'
import { renderMarkdown } from '@/lib/markdown'
import { cn, relativeTime } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useChatStore } from '@/stores/chat'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/**
 * 右侧 AI 助手
 *
 * 支持多会话、引用当前笔记、流式输出、结果插入到笔记。
 */
export function ChatPanel() {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const ai = useSettingsStore((state) => state.ai)
  const openSettings = useUiStore((state) => state.openSettings)

  const chats = useChatStore((state) => state.chats)
  const activeId = useChatStore((state) => state.activeId)
  const messages = useChatStore((state) => state.messages)
  const streaming = useChatStore((state) => state.streaming)
  const streamText = useChatStore((state) => state.streamText)
  const error = useChatStore((state) => state.error)
  const send = useChatStore((state) => state.send)
  const stop = useChatStore((state) => state.stop)
  const newChat = useChatStore((state) => state.newChat)
  const openChat = useChatStore((state) => state.openChat)
  const removeChat = useChatStore((state) => state.removeChat)
  const clearError = useChatStore((state) => state.clearError)

  const activePath = useNotesStore((state) => state.activePath)

  const skills = useSettingsStore((state) => state.skills)
  const knowledgeDefault = useSettingsStore((state) => state.knowledgeEnabled)
  const toolsDefault = useSettingsStore((state) => state.mcpEnabled)
  const patchSettings = useSettingsStore((state) => state.patch)
  const contextFiles = useChatStore((state) => state.contextFiles)

  const [draft, setDraft] = useState('')
  const [withNote, setWithNote] = useState(false)
  const [withKnowledge, setWithKnowledge] = useState(knowledgeDefault)
  const [withTools, setWithTools] = useState(toolsDefault)
  const [skillId, setSkillId] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 设置页里开关知识库后，对话面板的默认值要跟着变（面板是常驻的，不会重新挂载）
  useEffect(() => setWithKnowledge(knowledgeDefault), [knowledgeDefault])
  useEffect(() => setWithTools(toolsDefault), [toolsDefault])

  const modelReady = Boolean(ai.baseUrl && ai.model)

  // 新消息与流式增量都滚到底部
  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, streamText, streaming])

  // 自动增高输入框
  useEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [draft])

  const submit = async () => {
    const text = draft.trim()
    if (!text || streaming) return
    setDraft('')
    await send(text, { withNote, withKnowledge, withTools, skillId: skillId || undefined })
  }

  const sortedChats = useMemo(() => chats.slice(0, 30), [chats])

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Sparkles className="size-3.5 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{t('chat.title')}</span>
          {ai.model ? (
            <span className="max-w-[120px] truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {ai.model}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-0.5">
          <Hint label={t('chat.new')}>
            <Button variant="ghost" size="icon-sm" onClick={() => void newChat()}>
              <MessageSquarePlus className="size-4" />
            </Button>
          </Hint>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel>{t('chat.history')}</DropdownMenuLabel>
              {sortedChats.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('common.empty')}</div>
              ) : (
                sortedChats.map((chat) => (
                  <DropdownMenuItem
                    key={chat.id}
                    className={cn('justify-between gap-2', chat.id === activeId && 'bg-muted')}
                    onSelect={() => void openChat(chat.id)}
                  >
                    <span className="max-w-[170px] truncate">{chat.title || t('common.untitled')}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {relativeTime(chat.updatedAt, locale)}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
              {activeId ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
                    onSelect={() => void removeChat(activeId)}
                  >
                    <Trash2 />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {!modelReady ? (
        <div className="m-3 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium">{t('chat.noModel')}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t('chat.noModelHint')}</p>
          <Button size="sm" className="mt-2 h-7" onClick={() => openSettings('ai')}>
            {t('chat.configure')}
          </Button>
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !streaming ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Sparkles className="size-4" />
            </div>
            <p className="text-sm font-medium">{t('chat.empty')}</p>
            <p className="max-w-[220px] text-[11px] leading-relaxed text-muted-foreground">{t('chat.emptyHint')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) =>
              message.role === 'user' ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[92%] rounded-xl rounded-br-sm bg-muted px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                    {message.content}
                  </div>
                </div>
              ) : (
                <AssistantMessage key={message.id} content={message.content} />
              ),
            )}

            {streaming ? (
              <AssistantMessage
                content={streamText}
                streaming
                placeholder={t('chat.thinking')}
              />
            ) : null}
          </div>
        )}

        {error && error !== 'no-model' ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
            <span className="flex-1 break-words">{t('chat.failed', { message: error })}</span>
            <button type="button" onClick={clearError} className="shrink-0 hover:opacity-70">
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border p-2.5">
        {contextFiles.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-muted-foreground">{t('chat.contextFiles')}</span>
            {contextFiles.map((name) => (
              <span key={name} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {name}
              </span>
            ))}
          </div>
        ) : null}
        <div className="rounded-xl border border-border bg-background transition-colors focus-within:border-ring/50">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
            rows={1}
            placeholder={t('chat.placeholder')}
            className="max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
            <button
              type="button"
              disabled={!activePath}
              onClick={() => setWithNote(!withNote)}
              className={cn(
                'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors disabled:opacity-40',
                withNote ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
              title={activePath || t('chat.noNote')}
            >
              {withNote ? <Check className="size-3" /> : <CornerDownLeft className="size-3" />}
              {t('chat.contextNote')}
            </button>

            <button
              type="button"
              onClick={() => setWithKnowledge(!withKnowledge)}
              aria-pressed={withKnowledge}
              className={cn(
                'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
                withKnowledge ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
              title={t('chat.contextKnowledgeHint')}
            >
              {withKnowledge ? <Check className="size-3" /> : <Library className="size-3" />}
              {t('chat.contextKnowledge')}
            </button>

            <button
              type="button"
              onClick={() => {
                setWithTools(!withTools)
                // 记住这次选择，下次打开对话面板保持一致
                patchSettings({ mcpEnabled: !withTools })
              }}
              aria-pressed={withTools}
              className={cn(
                'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
                withTools ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
              title={t('chat.contextToolsHint')}
            >
              {withTools ? <Check className="size-3" /> : <Wrench className="size-3" />}
              {t('chat.contextTools')}
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex h-6 max-w-28 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
                    skillId ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
                  )}
                  title={t('chat.skill')}
                >
                  <Wand2 className="size-3 shrink-0" />
                  <span className="truncate">
                    {skillId ? skills.find((item) => item.id === skillId)?.name ?? t('chat.skill') : t('chat.skill')}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                <DropdownMenuLabel>{t('chat.skill')}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setSkillId('')}>
                  {skillId ? null : <Check className="size-3.5" />}
                  {t('chat.skillNone')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {skills.map((item) => (
                  <DropdownMenuItem key={item.id} onSelect={() => setSkillId(item.id)}>
                    {skillId === item.id ? <Check className="size-3.5" /> : null}
                    {item.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="ml-auto flex items-center gap-1">
              {streaming ? (
                <Button size="icon-sm" variant="outline" onClick={() => void stop()} title={t('chat.stop')}>
                  <Square className="size-3.5" />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  onClick={() => void submit()}
                  disabled={!draft.trim() || !modelReady}
                  title={t('chat.send')}
                >
                  {streaming ? <Spinner className="text-primary-foreground" /> : <ArrowUp className="size-4" />}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 助手消息：Markdown 渲染 + 复制 / 插入操作 */
function AssistantMessage({
  content,
  streaming = false,
  placeholder,
}: {
  content: string
  streaming?: boolean
  placeholder?: string
}) {
  const t = useT()
  const html = useMemo(() => renderMarkdown(content), [content])
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const ok = await copyText(content)
    setCopied(ok)
    if (ok) window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="group">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-primary/70" />
        <span>AI</span>
      </div>
      {content ? (
        <div
          className="markdown-body text-[13px] leading-relaxed"
          data-selectable
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : streaming ? (
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="ml-1">{placeholder}</span>
        </div>
      ) : null}

      {content && !streaming ? (
        <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => void copy()}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? t('common.copied') : t('common.copy')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (insertToEditor(content)) {
                toast.success(t('chat.inserted'))
              } else {
                toast.error(t('chat.noNote'))
              }
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowUp className="size-3 rotate-180" />
            {t('chat.insertToNote')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
