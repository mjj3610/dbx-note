/**
 * 界面状态：侧栏页签、面板显隐、各类弹窗
 *
 * 与业务状态分开，避免对话框开关引起笔记列表重渲染。
 */
import { create } from 'zustand'

export type SidebarTab = 'files' | 'records' | 'canvases' | 'outline'
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
}))
