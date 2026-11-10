/**
 * 知识库状态（0.5.6 起是真向量库，不再是工作区索引快照）
 *
 * 参考项目用 `stores/vector.ts` + `stores/article.ts` 维护「哪些笔记已向量化」：
 * 文件树据此显示状态图标、编辑器底栏据此显示最后计算时间、菜单据此决定
 * 「计算向量 / 更新向量」的文案。这里把三处共用的状态收在一个 store 里。
 */
import { create } from 'zustand'

import * as rpc from '@/lib/rpc'
import type { RagIndexResult, RagOptions, RagStatus } from '@/lib/rpc'

interface KbState {
  /** 后端向量库统计；未就绪或 Sidecar 不可用时为 null */
  status: RagStatus | null
  /** 已索引的工作区相对路径（文件树状态图标用） */
  paths: string[]
  /** 最后索引时间（毫秒），0 表示从未计算 */
  updatedAt: number
  /** 正在做全量计算，菜单 / 底栏据此禁用按钮 */
  busy: boolean
  /** 重新拉取统计；失败时清空，不抛错 */
  refresh: () => Promise<void>
  /** 全量重新计算向量；返回 null 表示失败（错误信息由调用方展示） */
  reindex: (options?: RagOptions) => Promise<RagIndexResult | null>
}

export const useKbStore = create<KbState>((set, get) => ({
  status: null,
  paths: [],
  updatedAt: 0,
  busy: false,

  refresh: async () => {
    try {
      const status = await rpc.kbStatus()
      set({ status, paths: status.paths, updatedAt: status.lastIndexedAt })
    } catch {
      set({ status: null, paths: [], updatedAt: 0 })
    }
  },

  reindex: async (options) => {
    if (get().busy) return null
    set({ busy: true })
    try {
      const result = await rpc.kbReindexAll(options)
      await get().refresh()
      return result
    } catch {
      return null
    } finally {
      set({ busy: false })
    }
  },
}))
