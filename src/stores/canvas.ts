/**
 * 画布状态
 *
 * 画布是结构化文档（节点 + 连线），存在工作区 `canvases/*.canvas.json`，
 * 与 Markdown 文件树互不干扰；打开时读盘，编辑后 600ms 防抖整篇回写。
 */
import { create } from 'zustand'

import { shapeDefaultSize, type CanvasShapeType } from '@/lib/canvasShapes'
import type { CanvasChartSpec } from '@/lib/canvasChart'
import * as rpc from '@/lib/rpc'
import type { CanvasItem } from '@/lib/rpc'
import { localId } from '@/lib/utils'

export type CanvasSaveState = 'idle' | 'saving' | 'saved' | 'error'

/** 节点形态：卡片（默认）/ 流程图图形 / 数据图表 / 图片 / 手绘笔迹 */
export type CanvasNodeKind = 'card' | 'shape' | 'chart' | 'image' | 'freehand'

export interface CanvasStroke {
  /** 相对节点左上角的点序列，[x, y] */
  points: [number, number][]
  color: string
  width: number
  /** 荧光笔是半透明粗笔，铅笔是细笔 */
  mode: 'pen' | 'highlighter'
}

export interface CanvasNode {
  id: string
  x: number
  y: number
  text: string
  /** 语义色：用于区分想法 / 待办 / 结论 */
  tone?: 'default' | 'idea' | 'todo' | 'done'
  /** 缺省为卡片，旧画布文件没有这个字段 */
  kind?: CanvasNodeKind
  /** kind=shape 时的图形类型 */
  shape?: CanvasShapeType
  /** 自定义尺寸（图形 / 图表 / 图片 / 笔迹都用它，卡片缺省固定） */
  w?: number
  h?: number
  /** kind=chart 的数据与样式 */
  chart?: CanvasChartSpec
  /** kind=image 的图片（src 是工作区相对路径） */
  image?: { src: string; name: string }
  /** kind=freehand 的笔迹 */
  stroke?: CanvasStroke
}

/** 卡片的固定尺寸（老画布与连线端点算法都按它算） */
export const CARD_W = 208
export const CARD_H = 76

/** 节点实际尺寸：优先用节点自带的 w/h，否则按类型给默认值 */
export function nodeSize(node: CanvasNode): { w: number; h: number } {
  if (node.w && node.h) return { w: node.w, h: node.h }
  if (node.kind === 'shape' && node.shape) return shapeDefaultSize(node.shape)
  if (node.kind === 'chart') return { w: 520, h: 340 }
  if (node.kind === 'image') return { w: 260, h: 180 }
  if (node.kind === 'freehand' && node.stroke) {
    const xs = node.stroke.points.map((point) => point[0])
    const ys = node.stroke.points.map((point) => point[1])
    return {
      w: Math.max(8, Math.max(...xs) - Math.min(...xs)),
      h: Math.max(8, Math.max(...ys) - Math.min(...ys)),
    }
  }
  return { w: CARD_W, h: CARD_H }
}


export interface CanvasEdge {
  id: string
  from: string
  to: string
}

export interface CanvasDoc {
  version: number
  title: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  updatedAt: number
}

function emptyDoc(title: string): CanvasDoc {
  return { version: 1, title, nodes: [], edges: [], updatedAt: Date.now() }
}

let saveTimer: number | undefined

/** 立即写盘（切换画布 / 关闭前调用） */
export async function flushCanvasSave(): Promise<void> {
  if (saveTimer) {
    window.clearTimeout(saveTimer)
    saveTimer = undefined
  }
  const state = useCanvasStore.getState()
  if (state.activePath && state.dirty) await state.save({ force: true })
}

interface CanvasState {
  items: CanvasItem[]
  loading: boolean
  activePath: string
  doc: CanvasDoc | null
  dirty: boolean
  saveState: CanvasSaveState
  error: string | null

  loadList: () => Promise<void>
  create: (name: string) => Promise<void>
  open: (path: string) => Promise<void>
  close: () => void
  rename: (path: string, name: string) => Promise<void>
  remove: (path: string) => Promise<void>
  save: (options?: { force?: boolean }) => Promise<void>

  addNode: (x: number, y: number, text?: string, extras?: Partial<CanvasNode>) => string
  updateNode: (id: string, patch: Partial<CanvasNode>) => void
  removeNode: (id: string) => void
  addEdge: (from: string, to: string) => void
  removeEdge: (id: string) => void
  setTitle: (title: string) => void
  /** 自动布局：把节点排成两列，便于「整理成脑图」后一键归位 */
  tidy: () => void
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  items: [],
  loading: false,
  activePath: '',
  doc: null,
  dirty: false,
  saveState: 'idle',
  error: null,

  loadList: async () => {
    set({ loading: true })
    try {
      const result = await rpc.canvasList()
      set({ items: result.items, loading: false, error: null })
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  create: async (name) => {
    const created = await rpc.canvasCreate(name || '未命名画布')
    await get().loadList()
    await get().open(created.path)
  },

  open: async (path) => {
    if (!path || get().activePath === path) return
    await flushCanvasSave()
    set({ error: null })
    try {
      const file = await rpc.canvasRead(path)
      const parsed = JSON.parse(file.content) as Partial<CanvasDoc>
      const doc: CanvasDoc = {
        version: parsed.version ?? 1,
        title: parsed.title ?? path,
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        updatedAt: parsed.updatedAt ?? Date.now(),
      }
      set({ activePath: path, doc, dirty: false, saveState: 'idle' })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  close: () => {
    void flushCanvasSave()
    set({ activePath: '', doc: null, dirty: false, saveState: 'idle' })
  },

  rename: async (path, name) => {
    const result = await rpc.canvasRename(path, name)
    await get().loadList()
    if (get().activePath === path) set({ activePath: result.path })
  },

  remove: async (path) => {
    await rpc.canvasDelete(path)
    if (get().activePath === path) set({ activePath: '', doc: null, dirty: false })
    await get().loadList()
  },

  save: async (options) => {
    const { activePath, doc, dirty } = get()
    if (!activePath || !doc) return
    if (!dirty && !options?.force) return
    set({ saveState: 'saving' })
    try {
      const next = { ...doc, updatedAt: Date.now() }
      await rpc.canvasSave(activePath, JSON.stringify(next))
      set({ doc: next, dirty: false, saveState: 'saved' })
      // 列表里的 updatedAt / title 跟着刷新，但不打断编辑
      void get().loadList()
    } catch (error) {
      set({ saveState: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  },

  addNode: (x, y, text = '', extras) => {
    const { doc } = get()
    if (!doc) return ''
    const id = localId()
    const nodes = [
      ...doc.nodes,
      { id, x: Math.round(x), y: Math.round(y), text, ...extras } as CanvasNode,
    ]
    set({ doc: { ...doc, nodes }, dirty: true })
    scheduleSave(get)
    return id
  },

  updateNode: (id, patch) => {
    const { doc } = get()
    if (!doc) return
    const nodes = doc.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node))
    set({ doc: { ...doc, nodes }, dirty: true })
    scheduleSave(get)
  },

  removeNode: (id) => {
    const { doc } = get()
    if (!doc) return
    set({
      doc: {
        ...doc,
        nodes: doc.nodes.filter((node) => node.id !== id),
        edges: doc.edges.filter((edge) => edge.from !== id && edge.to !== id),
      },
      dirty: true,
    })
    scheduleSave(get)
  },

  addEdge: (from, to) => {
    const { doc } = get()
    if (!doc || from === to) return
    if (doc.edges.some((edge) => edge.from === from && edge.to === to)) return
    const edges = [...doc.edges, { id: localId(), from, to }]
    set({ doc: { ...doc, edges }, dirty: true })
    scheduleSave(get)
  },

  removeEdge: (id) => {
    const { doc } = get()
    if (!doc) return
    set({ doc: { ...doc, edges: doc.edges.filter((edge) => edge.id !== id) }, dirty: true })
    scheduleSave(get)
  },

  setTitle: (title) => {
    const { doc } = get()
    if (!doc) return
    set({ doc: { ...doc, title }, dirty: true })
    scheduleSave(get)
  },

  tidy: () => {
    const { doc } = get()
    if (!doc) return
    // 按节点实际尺寸排两列，图形 / 图表不会再互相压住
    const columnX = [80, 400]
    const cursorY = [80, 80]
    const nodes = doc.nodes.map((node, index) => {
      const { w, h } = nodeSize(node)
      const column = index % 2
      const x = columnX[column] + (w > 380 ? -40 : 0)
      const y = cursorY[column]
      cursorY[column] = y + h + 40
      return { ...node, x, y }
    })
    set({ doc: { ...doc, nodes }, dirty: true })
    scheduleSave(get)
  },
}))

/** 600ms 防抖写盘；句柄暴露给 flushCanvasSave 以便切画布前强制落盘 */
function scheduleSave(get: () => CanvasState): void {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined
    void get().save()
  }, 600)
}

/** 当前画布的标题（无画布时为空） */
export function canvasTitle(): string {
  return useCanvasStore.getState().doc?.title ?? ''
}

export { emptyDoc }
