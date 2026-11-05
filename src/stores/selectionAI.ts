/**
 * 选区 AI 的状态（润色 / 精简 / 扩展 / 翻译）
 *
 * 放在 store 里而不是组件内，是因为触发按钮在气泡工具条里：
 * 一旦开始请求，工具条会随选区变化收起（整块卸载），面板必须活在外面。
 * 请求本身走 `ai/start` + `ai/poll` 流式通道，输出先落到面板里预览，
 * 用户点「替换选区」才动文档——这样中途反悔不会污染正文。
 */
import { create } from 'zustand'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'

import * as rpc from '@/lib/rpc'
import { buildSelectionMessages, type SelectionAIAction } from '@/lib/selectionAI'
import { useSettingsStore } from '@/stores/settings'

const POLL_INTERVAL = 140
const MAX_WAIT = 180_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface SelectionAIRequest {
  action: SelectionAIAction
  /** 原文（去空白后非空才会发起） */
  text: string
  /** 目标语言（仅 translate 用，已本地化的展示名） */
  language?: string
  /** 发起时的选区位置与文档快照，用于「替换选区」时判断文档是否已被改动 */
  from: number
  to: number
  doc: PMNode
  /** 面板锚点：选区末尾的屏幕坐标 */
  anchor: { top: number; left: number }
}

interface SelectionAIState {
  request: SelectionAIRequest | null
  output: string
  streaming: boolean
  /** 'no-model' 表示未配置模型；其余为错误信息 */
  error: string
  streamId: string
  start: (request: SelectionAIRequest) => Promise<void>
  cancel: () => void
  close: () => void
  /** 把结果写回文档：replace 替换选区，insert 插到选区之后 */
  apply: (editor: Editor, mode: 'replace' | 'insert') => boolean
}

export const useSelectionAIStore = create<SelectionAIState>((set, get) => ({
  request: null,
  output: '',
  streaming: false,
  error: '',
  streamId: '',

  start: async (request) => {
    const settings = useSettingsStore.getState()
    const config = settings.ai
    get().cancel()

    if (!config.model.trim()) {
      set({ request, output: '', streaming: false, error: 'no-model' })
      return
    }

    set({ request, output: '', streaming: true, error: '' })
    try {
      const started = await rpc.aiStart({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        temperature: config.temperature,
        messages: buildSelectionMessages(request.action, request.text, {
          zh: settings.locale.startsWith('zh'),
          language: request.language,
        }),
      })
      set({ streamId: started.id })

      const begin = Date.now()
      let text = ''
      for (;;) {
        if (!get().streaming) break
        if (Date.now() - begin > MAX_WAIT) throw new Error('timeout')
        const chunk = await rpc.aiPoll(started.id)
        if (chunk.text !== text) {
          text = chunk.text
          set({ output: text })
        }
        if (chunk.done) {
          if (chunk.error) throw new Error(chunk.error)
          break
        }
        await sleep(POLL_INTERVAL)
      }
      set({ streaming: false, streamId: '' })
    } catch (error) {
      if (!get().streaming) return // 已被取消，不要把取消当失败
      set({
        streaming: false,
        streamId: '',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  cancel: () => {
    const id = get().streamId
    if (id) void rpc.aiCancel(id).catch(() => undefined)
    set({ streaming: false, streamId: '' })
  },

  close: () => {
    get().cancel()
    set({ request: null, output: '', streaming: false, error: '' })
  },

  apply: (editor, mode) => {
    const { request, output } = get()
    const text = output.trim()
    if (!request || !text || editor.isDestroyed) return false

    // 文档没被动过就按原选区写回；动过则退回到当前选区，避免覆盖错位置
    const intact = request.doc === editor.state.doc
    const from = intact ? request.from : editor.state.selection.from
    const to = intact ? request.to : editor.state.selection.to

    if (mode === 'replace') {
      editor.chain().focus().insertContentAt({ from, to }, text, { contentType: 'markdown' }).run()
    } else {
      editor.chain().focus().insertContentAt(to, `\n\n${text}\n`, { contentType: 'markdown' }).run()
    }
    set({ request: null, output: '', streaming: false, error: '' })
    return true
  },
}))
