/**
 * 界面状态：侧栏页签、面板显隐、各类弹窗
 *
 * 与业务状态分开，避免对话框开关引起笔记列表重渲染。
 */
import { create } from 'zustand'

/** 'graph' 不占侧栏面板：选中后中间大区切换为知识图谱，侧栏只放控制器 */
export type SidebarTab = 'files' | 'records' | 'canvases' | 'outline' | 'graph'
/** 设置左栏的页签集合，与 NoteGen 的设置导航一一对应 */
export type SettingsTab =
  | 'about'
  | 'general'
  | 'record'
  | 'editor'
  | 'canvas'
  | 'shortcuts'
  | 'imageMethod'
  | 'audio'
  | 'ai'
  | 'webSearch'
  | 'rag'
  | 'memories'
  | 'prompt'
  | 'mcp'
  | 'skills'
  | 'template'
  | 'sync'
  | 'backup'
  | 'imageHosting'
  | 'file'
  | 'plugins'
/** 窄屏下的单栏视图 */
export type MobilePane = 'sidebar' | 'editor' | 'chat'

interface UiState {
  leftVisible: boolean
  rightVisible: boolean
  tab: SidebarTab
  settingsOpen: boolean
  settingsTab: SettingsTab
  searchOpen: boolean
  dirPickerOpen: boolean
  /** 新建条目的内联输入状态 */
  newItem: { kind: 'file' | 'folder'; parent: string } | null
  /** 正在重命名的路径 */
  renameTarget: string | null
  /** 待确认删除的路径 */
  deleteTarget: string | null
  mobilePane: MobilePane
  /** 并排对照面板正在显示的文件路径，null 表示不显示 */
  sidePane: string | null
  /** 正在预览的图片路径 */
  imagePreview: string | null
  /** 语音转写弹窗 */
  voiceOpen: boolean
  /** 同步冲突弹窗：本地与远端内容都在改，等用户选保留哪边 */
  syncConflict: { path: string; local: string; remote: string } | null
  /** 文件树剪贴板：剪切 / 复制后由「粘贴」落到目标目录 */
  fileClipboard: { mode: 'cut' | 'copy'; path: string } | null
  /** 文件树当前选中的节点，用于 F2 / Delete / Ctrl+X/C/V 快捷键 */
  selectedTreePath: string | null
  /** 右键「只读打开」的笔记：在编辑器里只展示、不允许改动 */
  readOnlyPaths: string[]

  setTab: (tab: SidebarTab) => void
  toggleLeft: () => void
  toggleRight: () => void
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  setSearchOpen: (open: boolean) => void
  setDirPickerOpen: (open: boolean) => void
  startNewItem: (kind: 'file' | 'folder', parent: string) => void
  cancelNewItem: () => void
  startRename: (path: string) => void
  cancelRename: () => void
  confirmDelete: (path: string) => void
  cancelDelete: () => void
  setMobilePane: (pane: MobilePane) => void
  setSidePane: (path: string | null) => void
  setImagePreview: (path: string | null) => void
  setVoiceOpen: (open: boolean) => void
  showSyncConflict: (conflict: { path: string; local: string; remote: string }) => void
  closeSyncConflict: () => void
  setFileClipboard: (clip: { mode: 'cut' | 'copy'; path: string } | null) => void
  setSelectedTreePath: (path: string | null) => void
  /** 切换某篇笔记的只读状态；路径从文件树移除时状态自然失效 */
  setReadOnly: (path: string, value: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  leftVisible: true,
  rightVisible: true,
  tab: 'files',
  settingsOpen: false,
  settingsTab: 'general',
  searchOpen: false,
  dirPickerOpen: false,
  newItem: null,
  renameTarget: null,
  deleteTarget: null,
  mobilePane: 'editor',
  sidePane: null,
  imagePreview: null,
  voiceOpen: false,
  syncConflict: null,
  fileClipboard: null,
  selectedTreePath: null,
  readOnlyPaths: [],

  setTab: (tab) => set({ tab }),
  toggleLeft: () => set((state) => ({ leftVisible: !state.leftVisible })),
  toggleRight: () => set((state) => ({ rightVisible: !state.rightVisible })),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? 'general' }),
  closeSettings: () => set({ settingsOpen: false }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setDirPickerOpen: (open) => set({ dirPickerOpen: open }),
  startNewItem: (kind, parent) => set({ newItem: { kind, parent } }),
  cancelNewItem: () => set({ newItem: null }),
  startRename: (path) => set({ renameTarget: path }),
  cancelRename: () => set({ renameTarget: null }),
  confirmDelete: (path) => set({ deleteTarget: path }),
  cancelDelete: () => set({ deleteTarget: null }),
  setMobilePane: (pane) => set({ mobilePane: pane }),
  setSidePane: (path) => set({ sidePane: path }),
  setImagePreview: (path) => set({ imagePreview: path }),
  setVoiceOpen: (open) => set({ voiceOpen: open }),
  showSyncConflict: (conflict) => set({ syncConflict: conflict }),
  closeSyncConflict: () => set({ syncConflict: null }),
  setFileClipboard: (clip) => set({ fileClipboard: clip }),
  setSelectedTreePath: (path) => set({ selectedTreePath: path }),
  setReadOnly: (path, value) =>
    set((state) => ({
      readOnlyPaths: value
        ? state.readOnlyPaths.includes(path)
          ? state.readOnlyPaths
          : [...state.readOnlyPaths, path]
        : state.readOnlyPaths.filter((item) => item !== path),
    })),
}))
