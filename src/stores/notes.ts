/**
 * 笔记（工作区文件）状态
 *
 * - 文件树来自 Sidecar，不在前端缓存内容；
 * - 支持多标签：每个标签只记路径与脏标记，正文仅保留「当前标签」一份，
 *   切标签时先 flush 再读盘，避免多份副本互相覆盖；
 * - 打开文件时读取正文，编辑后 800ms 防抖自动保存；
 * - 切换文件或关闭前强制 flush，避免丢字。
 */
import { create } from 'zustand'

import * as rpc from '@/lib/rpc'
import type { TreeNode } from '@/lib/rpc'
import { baseName, dirName } from '@/lib/utils'
import { findTreeNode, mergeRemoteTree } from '@/lib/tree'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { pullOnOpen, pullRemoteFileOnDemand, scheduleAutoSync } from '@/lib/autoSync'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface OutlineItem {
  level: number
  text: string
  line: number
}

/** 编辑器标签：只存元信息，正文随激活标签加载 */
export interface EditorTab {
  path: string
  name: string
  dirty: boolean
}

interface NotesState {
  tree: TreeNode[]
  loadingTree: boolean
  /** 正在拉取远端目录清单（状态栏的同步指示） */
  remoteSyncing: boolean
  /** 最近一次成功合并远端清单的时间 */
  remoteTreeAt: number
  expanded: string[]
  /** 打开的标签（按打开顺序） */
  tabs: EditorTab[]
  activePath: string
  title: string
  content: string
  savedContent: string
  loadingFile: boolean
  saveState: SaveState
  error: string | null
  /** 最近一次打开失败的文件，用于界面提示 */
  lastError: string | null

  loadTree: () => Promise<void>
  /** 只拉远端目录清单并合并进现有文件树，不重读本地磁盘 */
  refreshRemoteTree: (options?: { force?: boolean }) => Promise<void>
  /** `force` 用于「乐观接管」：activePath 已先切过去，仍要真正读一次盘 */
  open: (path: string, options?: { force?: boolean }) => Promise<void>
  /**
   * 重新读当前文件（手动拉取 / 解决冲突后调用）
   *
   * 有未保存改动时不动磁盘内容，只在 `force` 时强制以磁盘为准，
   * 避免把用户正在输入的文字冲掉。
   */
  reloadActive: (options?: { force?: boolean }) => Promise<void>
  restoreTabs: (paths: string[], activePath: string) => Promise<void>
  closeTab: (path: string) => Promise<void>
  closeTabs: (paths: string[]) => Promise<void>
  closeOtherTabs: (path: string) => Promise<void>
  closeAllTabs: () => Promise<void>
  closeFile: () => void
  setContent: (content: string) => void
  save: (options?: { force?: boolean }) => Promise<void>
  create: (kind: 'file' | 'folder', parent: string, name: string) => Promise<void>
  rename: (path: string, newName: string) => Promise<void>
  remove: (path: string) => Promise<void>
  toggleExpand: (path: string) => void
  /** 「全部折叠」：清空展开集合 */
  collapseAll: () => void
  expandTo: (path: string) => void
  outline: () => OutlineItem[]
}

/** 自动保存防抖句柄 */
let saveTimer: number | undefined
/** 远端清单请求代号：慢请求回来时不能覆盖更新一次的结果 */
let remoteTreeGeneration = 0
/**
 * 两次清单刷新的最小间隔
 *
 * 每次刷新 Git 通道都要 `git fetch`，回到前台、新建文件、切标签都会触发；
 * 不去重的话会在后台堆出一串 git 进程，把界面交互拖慢（e2e 里表现为
 * 设置表单 / 按钮偶发渲染超时）。参考项目的 loadRemoteSyncFiles 也是
 * 「进入文件页拉一次」，不是每次状态变化都拉。
 */
const REMOTE_TREE_MIN_INTERVAL = 15_000

/** 标签记忆存在 Sidecar 的 settings 表（宿主沙箱没有 localStorage） */
const TABS_SETTING_KEY = 'app.tabs'

/** 记住打开的标签与激活项，下次启动恢复 */
function persistTabs(tabs: EditorTab[], activePath: string): void {
  void rpc.setSetting(TABS_SETTING_KEY, { tabs: tabs.map((tab) => tab.path), activePath }).catch(() => {
    /* 忽略：仅影响记忆功能 */
  })
}

/** 读取上次的标签列表，损坏时返回空 */
export async function rememberedTabs(): Promise<{ tabs: string[]; activePath: string }> {
  try {
    const stored = await rpc.getSetting<{ tabs?: unknown; activePath?: unknown }>(TABS_SETTING_KEY)
    const tabs = Array.isArray(stored?.tabs)
      ? stored.tabs.filter((item): item is string => typeof item === 'string')
      : []
    const activePath = typeof stored?.activePath === 'string' ? stored.activePath : ''
    return { tabs, activePath }
  } catch {
    return { tabs: [], activePath: '' }
  }
}

/** 强制写盘（切换文件、卸载时调用） */
export async function flushPendingSave(): Promise<void> {
  if (saveTimer) {
    window.clearTimeout(saveTimer)
    saveTimer = undefined
  }
  const state = useNotesStore.getState()
  if (state.activePath && state.content !== state.savedContent) {
    await state.save({ force: true })
  }
}

/** 清空编辑器内容（关闭最后一个标签时用） */
function blankEditor() {
  return { activePath: '', title: '', content: '', savedContent: '', saveState: 'idle' as SaveState }
}

type NotesSetter = (partial: Partial<NotesState>) => void
type NotesGetter = () => NotesState

/**
 * 乐观接管标签（关闭当前标签、关闭其它标签、删除文件后共用）
 *
 * 旧写法是 `set({ tabs, ...blankEditor() })` 再 `await open(next.path)`：
 * 中间一段时间 `activePath === ''`，EditorPane 会卸载整棵编辑器子树（含标签栏），
 * 表现为「其他 tab 先全部消失，过一会才回来」。
 *
 * 这里改成同一次 `set` 就把 `tabs` 与 `activePath` 一起切到邻居，再异步读盘：
 * 标签栏始终挂载，正文区由 `loadingFile` 显示加载态。读盘失败时回退到空编辑器，
 * 但保留剩余标签，用户仍能点其它 tab 重试。
 */
async function takeOverTab(
  set: NotesSetter,
  get: NotesGetter,
  nextTabs: EditorTab[],
  next: EditorTab,
): Promise<void> {
  set({
    tabs: nextTabs,
    activePath: next.path,
    title: baseName(next.path),
    content: '',
    savedContent: '',
    loadingFile: true,
    saveState: 'idle',
    lastError: null,
  })
  persistTabs(nextTabs, next.path)
  try {
    await get().open(next.path, { force: true })
  } catch {
    set({ ...blankEditor(), loadingFile: false })
  }
}

/** 更新某个标签的字段，路径不存在时原样返回 */
function updateTab(tabs: EditorTab[], path: string, patch: Partial<EditorTab>): EditorTab[] {
  return tabs.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab))
}

export const useNotesStore = create<NotesState>((set, get) => ({
  tree: [],
  loadingTree: false,
  remoteSyncing: false,
  remoteTreeAt: 0,
  expanded: [],
  tabs: [],
  activePath: '',
  title: '',
  content: '',
  savedContent: '',
  loadingFile: false,
  saveState: 'idle',
  error: null,
  lastError: null,

  loadTree: async () => {
    set({ loadingTree: true })
    try {
      const result = await rpc.readTree()
      set({ tree: result.children, loadingTree: false, error: null })
    } catch (error) {
      set({
        loadingTree: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // 参考项目在 loadFileTree() 末尾无条件异步执行 loadRemoteSyncFiles()，
    // 且不阻塞界面：这里同样只拉「目录清单」，不下载任何笔记正文。
    void get().refreshRemoteTree()
  },

  /**
   * 拉取远端目录清单并合并进文件树
   *
   * 与参考项目 `loadRemoteSyncFiles()` 对齐：只合并元信息，仅云端节点显示出来，
   * 点开时再下正文；离线 / 未配置同步时静默保留本地树，不打断使用。
   */
  refreshRemoteTree: async (options) => {
    // 已有请求在飞：无论谁触发都跳过，绝不叠第二次 git fetch。
    // 时间节流只作用于 loadTree 这类高频内部调用；用户切回前台（force）总能拉一次。
    const now = Date.now()
    const { remoteSyncing, remoteTreeAt } = get()
    if (remoteSyncing) return
    if (!options?.force && remoteTreeAt > 0 && now - remoteTreeAt < REMOTE_TREE_MIN_INTERVAL) return

    const generation = ++remoteTreeGeneration
    set({ remoteSyncing: true })
    try {
      const snapshot = await rpc.syncRemoteTree()
      if (generation !== remoteTreeGeneration) return
      if (!snapshot.configured || snapshot.offline) return
      const tree = mergeRemoteTree(get().tree, snapshot.files)
      set({ tree, remoteTreeAt: Date.now() })

      // 清单已经 fetch 过一次，这里直接复用结果拉当前这篇，不再发第二次
      // compare / fetch。只对「本地未改、远端有新版本」生效，冲突仍交给弹窗。
      const activePath = get().activePath
      const active = snapshot.files.find((item) => item.path === activePath)
      if (activePath && active?.status === 'updated' && active.localExists) {
        await pullRemoteFileOnDemand(activePath)
        await get().reloadActive()
      }
    } catch {
      // 同步不可用不影响本地笔记，设置页里能看到具体原因
    } finally {
      if (generation === remoteTreeGeneration) set({ remoteSyncing: false })
    }
  },

  open: async (path, options) => {
    if (!path) return
    const state = get()
    if (state.activePath === path && !options?.force) return
    // 先落盘上一篇，再切换
    await flushPendingSave()

    set({ loadingFile: true, lastError: null })
    try {
      // 先比对远端、按需拉取，再读盘。
      // 顺序不能反：以前是「读盘 → 异步 pull」，拉完编辑器仍持有旧内容，
      // 用户一编辑保存就会把刚拉下来的版本覆盖掉（等于回滚远端更新）。
      const node = findTreeNode(get().tree, path)
      if (node?.remoteOnly) {
        // 参考项目 `pullMissingRemoteArticle()`：节点只存在于云端，本地磁盘没有，
        // 点开时先把这一个文件下下来。此路径不看 autoPullOnOpen 开关。
        await pullRemoteFileOnDemand(path)
        void get().loadTree()
      } else {
        const pulled = await pullOnOpen(path).catch(() => null)
        if (pulled?.conflict) {
          // 两边都改过：本地内容先照常渲染，同时弹窗让用户选保留哪边
          useUiStore.getState().showSyncConflict(pulled.conflict)
        }
      }
      const file = await rpc.readFile(path)
      const opened = get().tabs.some((tab) => tab.path === path)
      const tabs = opened
        ? get().tabs
        : [...get().tabs, { path, name: baseName(path), dirty: false }]
      set({
        tabs,
        activePath: path,
        title: baseName(path),
        content: file.content,
        savedContent: file.content,
        loadingFile: false,
        saveState: 'idle',
      })
      persistTabs(tabs, path)
      get().expandTo(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ loadingFile: false, lastError: message })
      throw error
    }
  },

  /** 重新读当前文件：手动拉取、解决冲突、拉取全部之后调用 */
  reloadActive: async (options) => {
    const { activePath, content, savedContent, tabs } = get()
    if (!activePath) return
    if (!options?.force && content !== savedContent) return
    try {
      const file = await rpc.readFile(activePath)
      set({
        content: file.content,
        savedContent: file.content,
        tabs: updateTab(tabs, activePath, { dirty: false }),
        saveState: 'idle',
      })
    } catch (error) {
      // 文件可能在远端被删了：保留现状，只在状态栏提示
      set({ lastError: error instanceof Error ? error.message : String(error) })
    }
  },

  /** 恢复上次的标签；文件已被删除的标签静默丢弃 */
  restoreTabs: async (paths, activePath) => {
    if (get().tabs.length > 0) return
    const unique = Array.from(new Set(paths.filter(Boolean)))
    if (unique.length === 0) return

    // 逐个校验，避免记忆里残留已删除 / 已重命名的文件
    const alive: string[] = []
    for (const path of unique) {
      try {
        const info = await rpc.statEntry(path)
        if (info.exists && !info.isDir) alive.push(path)
      } catch {
        /* 校验失败按不存在处理 */
      }
    }
    if (alive.length === 0) return

    const seed: EditorTab[] = alive.map((path) => ({ path, name: baseName(path), dirty: false }))
    set({ tabs: seed })
    const target = seed.find((tab) => tab.path === activePath) ?? seed[0]
    try {
      await get().open(target.path)
    } catch {
      await get().closeTabs([target.path])
    }
  },

  closeTab: async (path) => {
    await get().closeTabs([path])
  },

  /** 批量关闭：激活标签在被关集合内时，自动接管最近的邻居 */
  closeTabs: async (paths) => {
    const removeSet = new Set(paths.filter(Boolean))
    if (removeSet.size === 0) return
    const { tabs, activePath } = get()
    const activeIndex = tabs.findIndex((tab) => tab.path === activePath)
    const closingActive = removeSet.has(activePath)
    if (closingActive) await flushPendingSave()

    const nextTabs = tabs.filter((tab) => !removeSet.has(tab.path))
    if (!closingActive) {
      set({ tabs: nextTabs })
      persistTabs(nextTabs, activePath)
      return
    }

    const next = nextTabs[Math.min(activeIndex, nextTabs.length - 1)]
    if (next) {
      await takeOverTab(set, get, nextTabs, next)
    } else {
      set({ tabs: nextTabs, ...blankEditor(), loadingFile: false })
      persistTabs([], '')
    }
  },

  closeOtherTabs: async (path) => {
    await flushPendingSave()
    const keep = get().tabs.find((tab) => tab.path === path)
    if (!keep) return
    if (get().activePath !== path) {
      await takeOverTab(set, get, [keep], keep)
    } else {
      set({ tabs: [keep] })
      persistTabs([keep], path)
    }
  },

  closeAllTabs: async () => {
    await flushPendingSave()
    set({ tabs: [], ...blankEditor() })
    persistTabs([], '')
  },

  closeFile: () => {
    const { activePath } = get()
    if (activePath) {
      void get().closeTab(activePath)
      return
    }
    set(blankEditor())
  },

  setContent: (content) => {
    const { activePath, tabs } = get()
    set({
      content,
      saveState: 'idle',
      tabs: activePath ? updateTab(tabs, activePath, { dirty: true }) : tabs,
    })
    if (saveTimer) window.clearTimeout(saveTimer)
    // 防抖间隔跟随「设置 → 编辑器」的自动保存间隔
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined
      void get().save()
    }, useSettingsStore.getState().editor.autoSaveMs || 800)
  },

  save: async (options) => {
    const { activePath, content, savedContent } = get()
    if (!activePath) return
    if (!options?.force && content === savedContent) return
    set({ saveState: 'saving' })
    try {
      await rpc.writeFile(activePath, content)
      // 写盘期间可能已切到别的标签，只更新仍然匹配的那份
      if (get().activePath === activePath) {
        set({ savedContent: content, saveState: 'saved' })
      }
      set({ tabs: updateTab(get().tabs, activePath, { dirty: false }) })
      // 开了「自动上传」且当前是对象存储 / WebDAV / 自托管时，排队一次增量上传
      scheduleAutoSync()
      // 「自动更新知识库」：保存后增量重算本篇的向量分块（内容哈希未变时后端直接跳过）
      const settings = useSettingsStore.getState()
      if (settings.fileView.autoUpdateKnowledgeBase || settings.rag.autoVector) {
        void rpc
          .kbIndexFile(activePath, {
            chunkSize: settings.rag.chunkSize,
            chunkOverlap: settings.rag.chunkOverlap,
          })
          .catch((error) => {
            console.warn('[kb] 增量更新向量失败', error)
          })
      }
    } catch (error) {
      set({
        saveState: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },

  create: async (kind, parent, name) => {
    const result = await rpc.createEntry({ kind, parent, name })
    await get().loadTree()
    if (parent) get().expandTo(`${parent}/x`)
    if (kind === 'file') await get().open(result.path)
  },

  rename: async (path, newName) => {
    const result = await rpc.renameEntry(path, newName)
    const { activePath } = get()
    await get().loadTree()
    // 目录改名时，其下已打开的标签路径也要跟着改，否则会继续写旧路径
    const tabs = get().tabs.map((tab) => {
      if (tab.path === path) {
        return { ...tab, path: result.path, name: baseName(result.path) }
      }
      if (tab.path.startsWith(`${path}/`)) {
        const nextPath = `${result.path}/${tab.path.slice(path.length + 1)}`
        return { ...tab, path: nextPath, name: baseName(nextPath) }
      }
      return tab
    })
    set({ tabs })
    if (activePath === path || activePath.startsWith(`${path}/`)) {
      const nextPath = activePath === path ? result.path : `${result.path}/${activePath.slice(path.length + 1)}`
      set({ activePath: nextPath, title: baseName(nextPath) })
      persistTabs(tabs, nextPath)
    }
  },

  remove: async (path) => {
    await rpc.deleteEntry(path)
    const { activePath, tabs } = get()
    const removed = tabs.filter((tab) => tab.path === path || tab.path.startsWith(`${path}/`))
    if (removed.length > 0) {
      const nextTabs = tabs.filter((tab) => !removed.includes(tab))
      const activeRemoved = removed.some((tab) => tab.path === activePath)
      set({ tabs: nextTabs })
      if (activeRemoved) {
        const index = tabs.findIndex((tab) => tab.path === activePath)
        const next = nextTabs[index] ?? nextTabs[index - 1] ?? null
        if (next) await takeOverTab(set, get, nextTabs, next)
        else persistTabs([], '')
      }
    }
    await get().loadTree()
  },

  toggleExpand: (path) => {
    const { expanded } = get()
    set({
      expanded: expanded.includes(path) ? expanded.filter((item) => item !== path) : [...expanded, path],
    })
  },

  collapseAll: () => set({ expanded: [] }),

  /** 展开某个路径的所有父级目录 */
  expandTo: (path) => {
    const parts = path.split('/')
    const parents: string[] = []
    for (let index = 1; index < parts.length; index += 1) {
      parents.push(parts.slice(0, index).join('/'))
    }
    if (parents.length === 0) return
    const merged = new Set([...get().expanded, ...parents])
    set({ expanded: [...merged] })
  },

  outline: () => parseOutline(get().content),
}))

/** 解析 Markdown 标题（跳过代码块内的 #） */
export function parseOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let inFence = false
  markdown.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) {
      items.push({ level: match[1].length, text: match[2].trim(), line: index })
    }
  })
  return items
}

/** 取当前文件的目录，新建文件时默认落在同级 */
export function currentFolder(): string {
  return dirName(useNotesStore.getState().activePath)
}
