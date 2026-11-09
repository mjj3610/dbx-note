/**
 * 知识库索引状态
 *
 * 参考项目的「显示知识库状态」会在文件树标出已向量化的笔记；本项目等价映射为
 * 工作区 `.dbx-note/kb-index.json` 里的索引路径。菜单与文件树共用这一份状态，
 * 索引变更后调用 refresh() 让标记立即刷新。
 */
import { create } from 'zustand'

import * as rpc from '@/lib/rpc'

interface KbState {
  /** 已收录进索引的工作区相对路径 */
  paths: string[]
  updatedAt: number
  refresh: () => Promise<void>
}

export const useKbStore = create<KbState>((set) => ({
  paths: [],
  updatedAt: 0,
  refresh: async () => {
    try {
      const status = await rpc.kbStatus()
      set({ paths: status.paths, updatedAt: status.updatedAt })
    } catch {
      set({ paths: [], updatedAt: 0 })
    }
  },
}))
