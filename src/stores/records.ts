/**
 * 碎片记录状态
 *
 * 记录存在 Sidecar 的 SQLite 中，按标签 / 类型 / 时间 / 关键词过滤；
 * 支持勾选多条后交给 AI 整理成笔记，也支持回收站（归档）与恢复。
 * 类型与时间取值的命名对齐 NoteGen 的 `mark-filters.ts`。
 */
import { create } from 'zustand'

import * as rpc from '@/lib/rpc'
import type { RecordItem, TagItem } from '@/lib/rpc'

export type TimeRange = 'all' | 'today' | 'last7Days' | 'last30Days'

export interface RecordFilter {
  tagId: string
  /** 多选类型；空数组表示全部 */
  types: string[]
  range: TimeRange
  query: string
  /** 回收站视图 */
  trashed: boolean
}

interface RecordsState {
  items: RecordItem[]
  tags: TagItem[]
  filter: RecordFilter
  selected: string[]
  loading: boolean
  error: string | null

  load: () => Promise<void>
  loadTags: () => Promise<void>
  add: (content: string, type?: string, tags?: string[]) => Promise<void>
  remove: (id: string) => Promise<void>
  archive: (id: string) => Promise<void>
  restore: (id: string) => Promise<void>
  /** todo 记录的完成勾选（写在 meta.done） */
  toggleTodo: (id: string, done: boolean) => Promise<void>
  toggleSelect: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  setFilter: (patch: Partial<RecordFilter>) => void
  selectedRecords: () => RecordItem[]
}

const DEFAULT_FILTER: RecordFilter = { tagId: '', types: [], range: 'all', query: '', trashed: false }

const DAY_IN_MS = 24 * 60 * 60 * 1000

/** 时间范围 → 起始时间戳 */
function rangeStart(range: TimeRange): number {
  const now = new Date()
  if (range === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  }
  if (range === 'last7Days') return Date.now() - 7 * DAY_IN_MS
  if (range === 'last30Days') return Date.now() - 30 * DAY_IN_MS
  return 0
}

export const useRecordsStore = create<RecordsState>((set, get) => ({
  items: [],
  tags: [],
  filter: DEFAULT_FILTER,
  selected: [],
  loading: false,
  error: null,

  load: async () => {
    const { filter } = get()
    set({ loading: true })
    try {
      const result = await rpc.listRecords({
        tagId: filter.tagId || undefined,
        query: filter.query || undefined,
        archived: filter.trashed ? 1 : 0,
        limit: 500,
      })
      const start = rangeStart(filter.range)
      const items = result.items.filter((item) => {
        if (start && item.createdAt < start) return false
        if (filter.types.length > 0 && !filter.types.includes(item.type)) return false
        return true
      })
      set({ items, loading: false, error: null })
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  loadTags: async () => {
    try {
      const result = await rpc.listTags()
      set({ tags: result.items })
    } catch (error) {
      console.warn('[records] 读取标签失败', error)
    }
  },

  add: async (content, type = 'text', tags = []) => {
    const trimmed = content.trim()
    if (!trimmed) return
    await rpc.createRecord({ type, content: trimmed, tags })
    await Promise.all([get().load(), get().loadTags()])
  },

  remove: async (id) => {
    await rpc.deleteRecord(id)
    set({ selected: get().selected.filter((item) => item !== id) })
    await Promise.all([get().load(), get().loadTags()])
  },

  archive: async (id) => {
    await rpc.updateRecord({ id, archived: true })
    set({ selected: get().selected.filter((item) => item !== id) })
    await Promise.all([get().load(), get().loadTags()])
  },

  restore: async (id) => {
    await rpc.updateRecord({ id, archived: false })
    set({ selected: get().selected.filter((item) => item !== id) })
    await get().load()
  },

  toggleTodo: async (id, done) => {
    // 先本地反映，避免勾选后要等一次往返
    set({
      items: get().items.map((item) =>
        item.id === id ? { ...item, meta: { ...item.meta, done } } : item,
      ),
    })
    try {
      await rpc.updateRecord({ id, meta: { done } })
    } catch (error) {
      set({
        items: get().items.map((item) =>
          item.id === id ? { ...item, meta: { ...item.meta, done: !done } } : item,
        ),
      })
      throw error
    }
  },

  toggleSelect: (id) => {
    const { selected } = get()
    set({
      selected: selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id],
    })
  },

  selectAll: () => set({ selected: get().items.map((item) => item.id) }),

  clearSelection: () => set({ selected: [] }),

  setFilter: (patch) => {
    set({ filter: { ...get().filter, ...patch } })
    void get().load()
  },

  selectedRecords: () => {
    const { items, selected } = get()
    return items.filter((item) => selected.includes(item.id))
  },
}))
