/**
 * AI 会话状态
 *
 * 流式输出由 Sidecar 后台线程累积、前端轮询 `ai/poll` 获得增量文本，
 * 这样无需依赖宿主的自定义事件通道。
 */
import { create } from 'zustand'

import * as rpc from '@/lib/rpc'
import type { AiMessage, ChatItem, MessageItem } from '@/lib/rpc'
import { useSettingsStore } from './settings'
import { useNotesStore } from './notes'
import { baseName, localId } from '@/lib/utils'

interface ChatState {
  chats: ChatItem[]
  activeId: string
  messages: MessageItem[]
  streaming: boolean
  streamText: string
  error: string | null
  /** 当前正在轮询的 Sidecar 流 id */
  streamId: string | null
  /** 本次提问引用的知识库文件（用于输入区提示） */
  contextFiles: string[]

  loadChats: () => Promise<void>
  openChat: (id: string) => Promise<void>
  newChat: () => Promise<void>
  removeChat: (id: string) => Promise<void>
  send: (
    text: string,
    options?: {
      withNote?: boolean
      withKnowledge?: boolean
      withTools?: boolean
      skillId?: string
      systemOverride?: string
      noteContent?: string
    },
  ) => Promise<void>
  stop: () => Promise<void>
  clearError: () => void
}

/** 空会话占位：真正落库在首条消息时创建 */
const EMPTY_CHAT: ChatItem = { id: '', title: '', createdAt: 0, updatedAt: 0 }

/** 轮询间隔（毫秒） */
const POLL_INTERVAL = 140
/** 单次对话最多等待时长（毫秒），与后端上限对齐 */
const MAX_WAIT = 180_000

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeId: '',
  messages: [],
  streaming: false,
  streamText: '',
  error: null,
  streamId: null,
  contextFiles: [],

  loadChats: async () => {
    try {
      const result = await rpc.listChats()
      set({ chats: result.items })
      const { activeId } = get()
      if (!activeId && result.items.length > 0) {
        await get().openChat(result.items[0].id)
      }
    } catch (error) {
      console.warn('[chat] 读取会话失败', error)
    }
  },

  openChat: async (id) => {
    if (!id) return
    set({ activeId: id, messages: [], streamText: '', error: null })
    try {
      const result = await rpc.listMessages(id)
      set({ messages: result.items })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  newChat: async () => {
    set({ activeId: '', messages: [], streamText: '', error: null })
  },

  removeChat: async (id) => {
    await rpc.deleteChat(id)
    const chats = get().chats.filter((item) => item.id !== id)
    set({ chats })
    if (get().activeId === id) {
      set({ activeId: '', messages: [] })
      if (chats.length > 0) await get().openChat(chats[0].id)
    }
  },

  send: async (text, options) => {
    const trimmed = text.trim()
    if (!trimmed || get().streaming) return

    const settings = useSettingsStore.getState()
    if (!settings.ai.baseUrl || !settings.ai.model) {
      set({ error: 'no-model' })
      return
    }

    let chatId = get().activeId
    if (!chatId) {
      const chat = await rpc.createChat(trimmed.slice(0, 24))
      chatId = chat.id
      set({ activeId: chatId, chats: [chat, ...get().chats] })
    }

    // 本地先显示用户消息，再落库
    const userMessage: MessageItem = {
      id: localId(),
      role: 'user',
      content: trimmed,
      meta: {},
      createdAt: Date.now(),
    }
    set({
      messages: [...get().messages, userMessage],
      streaming: true,
      streamText: '',
      error: null,
      contextFiles: [],
    })
    await rpc.appendMessage({ chatId, role: 'user', content: trimmed }).catch(() => undefined)

    // 组装上下文：系统提示 + 当前笔记 + 历史消息
    const notePath = useNotesStore.getState().activePath
    const noteContent = options?.noteContent ?? (options?.withNote ? useNotesStore.getState().content : '')
    const basePrompt =
      options?.systemOverride ??
      (settings.locale.startsWith('zh')
        ? '你是一个中文写作助手，回答简洁、准确，默认使用 Markdown。'
        : 'You are a concise, accurate writing assistant. Reply in Markdown.')

    // 技能 = 追加一段行为约束；记忆 = 长期偏好；知识库 = 检索到的片段
    const skill = options?.skillId
      ? settings.skills.find((item) => item.id === options.skillId)
      : undefined
    const skillBlock = skill ? `\n\n【技能：${skill.name}】${skill.prompt}` : ''
    const memoryBlock =
      settings.memories.length > 0
        ? `\n\n【长期记忆（用户偏好，始终遵守）】\n${settings.memories
            .slice(0, 50)
            .map((item) => `- ${item}`)
            .join('\n')}`
        : ''
    // 全局系统提示词（设置 → 提示词）追加在基础提示词之后
    const extraBlock = settings.prompt.systemExtra.trim()
      ? `\n\n【补充要求】\n${settings.prompt.systemExtra.trim()}`
      : ''
    const systemPrompt = `${basePrompt}${extraBlock}${skillBlock}${memoryBlock}${
      options?.withTools ? await buildToolBlock(settings.locale.startsWith('zh')) : ''
    }`

    let knowledgeBlock = ''
    if (options?.withKnowledge) {
      knowledgeBlock = await buildKnowledgeBlock(trimmed, settings.locale.startsWith('zh'), (files) =>
        set({ contextFiles: files }),
      )
    }

    const history: AiMessage[] = get()
      .messages.filter((item) => item.role !== 'system')
      .slice(-20)
      .map((item) => ({ role: item.role, content: item.content }))

    const contextBlock = noteContent
      ? `\n\n${settings.locale.startsWith('zh') ? `当前笔记《${baseName(notePath)}》的内容如下：` : `Current note “${baseName(notePath)}”:`}\n\n${noteContent.slice(0, 12_000)}`
      : ''

    const contextText = `${contextBlock}${knowledgeBlock}`.trim()
    const payload: AiMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      ...(contextText ? [{ role: 'user' as const, content: contextText }] : []),
    ]

    // 一次流式往返：启动 → 轮询，返回累积文本
    const streamChat = async (messages: AiMessage[]): Promise<string> => {
      const started = await rpc.aiStart({
        baseUrl: settings.ai.baseUrl,
        apiKey: settings.ai.apiKey,
        model: settings.ai.model,
        temperature: settings.ai.temperature,
        messages,
      })
      set({ streamId: started.id })

      const begin = Date.now()
      let text = ''
      for (;;) {
        if (!get().streaming) break
        if (Date.now() - begin > MAX_WAIT) throw new Error('响应超时')
        const chunk = await rpc.aiPoll(started.id)
        if (chunk.text !== text) {
          text = chunk.text
          set({ streamText: text })
        }
        if (chunk.done) {
          if (chunk.error) throw new Error(chunk.error)
          break
        }
        await sleep(POLL_INTERVAL)
      }
      return get().streamText.trim()
    }

    try {
      // 模型若在回答里请求了本机工具，执行后带着结果再问一轮（最多两轮，防止死循环）
      let conversation = payload
      let finalText = ''
      for (let round = 0; ; round += 1) {
        finalText = await streamChat(conversation)
        const request = round < 2 ? parseToolRequest(finalText) : null
        if (!request) break
        const outcome = await rpc
          .mcpCall(request.server, request.tool, request.args)
          .catch((error: unknown) => ({
            text: `工具调用失败：${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          }))
        conversation = [
          ...conversation,
          { role: 'assistant', content: finalText },
          {
            role: 'user',
            content: `【工具 ${request.tool} 的执行结果${outcome.isError ? '（失败）' : ''}】\n${outcome.text.slice(0, 6000)}`,
          },
        ]
        set({ streamText: '' })
      }

      if (finalText) {
        const assistant: MessageItem = {
          id: localId(),
          role: 'assistant',
          content: finalText,
          meta: {},
          createdAt: Date.now(),
        }
        set({ messages: [...get().messages, assistant] })
        await rpc.appendMessage({ chatId, role: 'assistant', content: finalText }).catch(() => undefined)
        await get().loadChats()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
    } finally {
      set({ streaming: false, streamText: '', streamId: null })
    }
  },

  stop: async () => {
    const { streamId } = get()
    if (streamId) {
      await rpc.aiCancel(streamId).catch(() => undefined)
    }
    const partial = get().streamText.trim()
    if (partial) {
      const assistant: MessageItem = {
        id: localId(),
        role: 'assistant',
        content: partial,
        meta: { stopped: true },
        createdAt: Date.now(),
      }
      set({ messages: [...get().messages, assistant] })
      const chatId = get().activeId
      if (chatId) {
        await rpc.appendMessage({ chatId, role: 'assistant', content: partial, meta: { stopped: true } }).catch(() => undefined)
      }
    }
    set({ streaming: false, streamText: '', streamId: null })
  },

  clearError: () => set({ error: null }),
}))

export { EMPTY_CHAT }

/**
 * 工具清单缓存：同一个「命令 + 参数」只探测一次
 *
 * 探测要拉起子进程（npx 首次还会装包），放进每次提问的路径上太慢，
 * 因此按服务签名缓存，配置一改就自然失效。
 */
const toolCache = new Map<string, rpc.McpTool[]>()

function serverSignature(server: rpc.McpServer): string {
  return `${server.command} ${server.args.join(' ')}`
}

/**
 * 把本机 MCP 工具写进系统提示
 *
 * 不走 function calling：沙箱里只有 OpenAI 兼容的纯文本流，
 * 用固定代码块格式让模型「申请调用」，前端解析后执行并把结果回灌，兼容性最好。
 */
async function buildToolBlock(zh: boolean): Promise<string> {
  try {
    const { servers } = await rpc.mcpList()
    const enabled = servers.filter((server) => server.enabled && server.command.trim())
    if (enabled.length === 0) return ''

    const lines: string[] = []
    for (const server of enabled) {
      const key = `${server.id}|${serverSignature(server)}`
      let tools = toolCache.get(key)
      if (!tools) {
        try {
          tools = (await rpc.mcpTools(server.id)).tools
          toolCache.set(key, tools)
        } catch {
          continue
        }
      }
      for (const tool of tools) {
        const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema).slice(0, 400) : '{}'
        lines.push(
          `- server="${server.id}" tool="${tool.name}": ${tool.description || ''} 参数结构 ${schema}`,
        )
      }
    }
    if (lines.length === 0) return ''

    const header = zh ? '【可调用的本机工具】' : '[Local tools you can call]'
    const rule = zh
      ? '需要用到工具时，不要臆造结果：单独输出一个 tool 代码块（```tool ... ```），内容为 JSON：' +
        '{"server":"服务 id","tool":"工具名","args":{...}}。拿到执行结果后再给最终回答，且不要重复输出该代码块。'
      : 'When a tool is needed, do not guess: emit a single ```tool block containing JSON ' +
        '{"server":"<id>","tool":"<name>","args":{...}}. After the result comes back, answer normally and do not repeat the block.'
    return `\n\n${header}\n${lines.join('\n')}\n${rule}`
  } catch {
    return ''
  }
}

/** 从模型输出里找出最后一个工具调用请求 */
function parseToolRequest(
  text: string,
): { server: string; tool: string; args: Record<string, unknown> } | null {
  const pattern = /```tool\s*\n([\s\S]*?)```/g
  let last: string | null = null
  for (const match of text.matchAll(pattern)) last = match[1]
  if (!last) return null
  try {
    const parsed = JSON.parse(last.trim()) as {
      server?: string
      tool?: string
      args?: Record<string, unknown>
    }
    if (!parsed.server || !parsed.tool) return null
    return { server: parsed.server, tool: parsed.tool, args: parsed.args ?? {} }
  } catch {
    return null
  }
}

/**
 * 知识库检索：用当前提问在工作区做全文搜索，取命中正文的几篇截断后拼成片段块。
 *
 * 不做向量化——插件运行在 `connect-src 'none'` 的沙箱里，也拿不到 embedding 服务；
 * 全文命中 + 截断已经能支撑「问自己的笔记」这类场景，且完全不产生额外网络请求。
 */
async function buildKnowledgeBlock(
  query: string,
  zh: boolean,
  onFiles: (files: string[]) => void,
): Promise<string> {
  try {
    const { items } = await rpc.searchFiles(query, 8)
    // 优先正文命中，其次文件名命中
    const contentHits = items.filter((hit) => hit.path && !hit.matchedName).slice(0, 3)
    const targets = contentHits.length > 0 ? contentHits : items.slice(0, 2).filter((hit) => hit.path)
    if (targets.length === 0) return ''

    const parts: string[] = []
    let budget = 6000
    for (const hit of targets) {
      if (budget <= 0) break
      try {
        const file = await rpc.readFile(hit.path)
        const text = file.content.slice(0, Math.min(1800, budget))
        budget -= text.length
        parts.push(`### ${hit.name}\n${text}`)
      } catch {
        /* 单篇读取失败跳过，不影响整体 */
      }
    }
    if (parts.length === 0) return ''
    onFiles(targets.map((hit) => hit.name))
    const header = zh
      ? '【知识库片段（来自当前工作区，回答时优先引用并注明出处）】'
      : '[Knowledge snippets from the current workspace — prefer citing them]'
    return `\n\n${header}\n\n${parts.join('\n\n')}`
  } catch {
    return ''
  }
}
