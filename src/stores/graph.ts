/**
 * 知识图谱状态（0.5.9）
 *
 * 图谱是向量库的只读派生视图：后端 `kb/graph` 按数据水印缓存快照，前端只在
 * 「切到图谱页签 / 手动刷新 / 改参数 / 发现关联」时才发 RPC，不与自动保存、
 * Git 同步抢 Sidecar 通道。请求用单 flight + 序号丢弃旧响应，避免 0.5.2 那种
 * 旧结果覆盖新结果的竞态。
 */
import { create } from 'zustand'

import * as rpc from '@/lib/rpc'
import type { GraphEdge, GraphNode, GraphSnapshot } from '@/lib/rpc'

/** 从图谱「打开原笔记」后派发，detail 为知识块摘要文本 */
export const REVEAL_CHUNK_EVENT = 'dbx-note:reveal-chunk'

export type GraphGranularity = 'source' | 'chunk'

interface GraphState {
  snapshot: GraphSnapshot | null
  busy: boolean
  /** 知识库在图谱算完之后又重新索引过 */
  stale: boolean
  error: string
  activated: boolean
  granularity: GraphGranularity
  threshold: number
  topK: number
  /** 当前选中的节点，右侧详情据此展示知识块 */
  selected: string | null
  /** 已经做过「发现关联」的节点 */
  expanded: string[]
  /** 侧栏 / 画布共用的节点过滤词 */
  keyword: string

  /** 切到图谱页签时调用：首次加载 / 过期重拉 / 命中缓存则直接返回 */
  activate: () => Promise<void>
  /** 重新生成快照；force 可与在途请求并存（旧响应会被丢弃） */
  refresh: (force?: boolean) => Promise<void>
  /** 以某节点为中心发现关联，把局部子图合并进当前快照 */
  expand: (nodeId: string) => Promise<void>
  select: (nodeId: string | null) => void
  setKeyword: (value: string) => void
  setGranularity: (value: GraphGranularity) => Promise<void>
  setThreshold: (value: number) => Promise<void>
  setTopK: (value: number) => Promise<void>
  /** 比对知识库 lastIndexedAt，判断快照是否需要刷新 */
  checkStale: () => Promise<void>
  markStale: () => void
  reset: () => void
}

/** 单 flight：同一时刻只允许一个生成请求，force 会顶掉旧请求的结果 */
let flight: Promise<void> | null = null
let sequence = 0

function mergeSnapshot(current: GraphSnapshot, extra: GraphSnapshot): GraphSnapshot {
  const nodes = new Map<string, GraphNode>(current.nodes.map((node) => [node.id, node]))
  for (const node of extra.nodes) nodes.set(node.id, node)
  const edges = new Map<string, GraphEdge>(
    current.edges.map((edge) => [`${edge.source}|${edge.target}`, edge]),
  )
  for (const edge of extra.edges) edges.set(`${edge.source}|${edge.target}`, edge)
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    meta: { ...current.meta, nodeCount: nodes.size, edgeCount: edges.size },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useGraphStore = create<GraphState>((set, get) => {
  const generate = async (): Promise<void> => {
    if (flight) return flight
    const token = ++sequence
    const run = (async () => {
      set({ busy: true, error: '', activated: true })
      try {
        const { granularity, threshold, topK } = get()
        const snapshot = await rpc.kbGraph({ granularity, threshold, topK })
        if (token !== sequence) return
        set({ snapshot, stale: false, selected: null, expanded: [] })
      } catch (error) {
        if (token !== sequence) return
        set({ error: errorMessage(error) })
      } finally {
        if (token === sequence) set({ busy: false })
      }
    })()
    const tracked = run.finally(() => {
      // 被 force / 改参数顶掉的旧请求结束时，不能清掉新请求持有的 flight
      if (flight === tracked) flight = null
    })
    flight = tracked
    return tracked
  }

  return {
    snapshot: null,
    busy: false,
    stale: false,
    error: '',
    activated: false,
    granularity: 'source',
    threshold: 0.35,
    topK: 4,
    selected: null,
    expanded: [],
    keyword: '',

    activate: async () => {
      const { snapshot, stale, activated } = get()
      if (activated && snapshot && !stale) return
      await get().refresh()
    },

    refresh: async (force = false) => {
      if (force) {
        // 主动刷新即使有在途请求也要重发：序号递增会让旧响应被丢弃
        sequence += 1
        flight = null
      }
      await generate()
      await get().checkStale()
    },

    expand: async (nodeId) => {
      if (get().busy || !nodeId) return
      set({ busy: true, error: '', selected: nodeId })
      try {
        const { granularity, threshold, topK } = get()
        const extra = await rpc.kbGraphNeighbors({ nodeId, granularity, threshold, topK })
        const current = get().snapshot
        set({
          snapshot: current ? mergeSnapshot(current, extra) : extra,
          expanded: [...new Set([...get().expanded, nodeId])],
          selected: nodeId,
        })
      } catch (error) {
        set({ error: errorMessage(error) })
      } finally {
        set({ busy: false })
      }
    },

    select: (nodeId) => set({ selected: nodeId }),
    setKeyword: (value) => set({ keyword: value }),

    setGranularity: async (value) => {
      if (get().granularity === value) return
      set({ granularity: value, selected: null, expanded: [] })
      sequence += 1
      flight = null
      await generate()
    },

    setThreshold: async (value) => {
      const next = Math.max(0, Math.min(1, value))
      if (get().threshold === next) return
      set({ threshold: next })
      sequence += 1
      flight = null
      await generate()
    },

    setTopK: async (value) => {
      const next = Math.max(1, Math.min(12, Math.round(value)))
      if (get().topK === next) return
      set({ topK: next })
      sequence += 1
      flight = null
      await generate()
    },

    checkStale: async () => {
      try {
        const status = await rpc.kbStatus()
        const snapshot = get().snapshot
        if (snapshot && status.lastIndexedAt > snapshot.meta.computedAt) set({ stale: true })
      } catch {
        // 知识库未就绪时不打扰图谱
      }
    },

    markStale: () => set({ stale: true }),
    reset: () => {
      sequence += 1
      flight = null
      set({
        snapshot: null, busy: false, stale: false, error: '', activated: false,
        selected: null, expanded: [], keyword: '',
      })
    },
  }
})
