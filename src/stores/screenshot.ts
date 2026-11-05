/**
 * 截图工具状态
 *
 * 触发点（全局快捷键 / 编辑器头部按钮）负责先让 Sidecar 在桌面上框选，拿到区域后把
 * `shot` 塞进来，浮层只做标注与导出。浮层由 App 常驻渲染——不能挂在触发器里面，
 * 否则切标签、关面板就把它带走了。
 */
import { create } from 'zustand'

/** screen=整屏（插件内框选），region=桌面已框好的区域，clipboard/global=剪贴板 / 全局热键 */
export type ShotSource = 'screen' | 'region' | 'clipboard' | 'global'

export interface ShotCapture {
  /** data URL，直接喂给 <img>/canvas */
  dataUrl: string
  width: number
  height: number
  source: ShotSource
  /** 进来就是已框好的区域，浮层直接把选区铺满整张图 */
  preselected: boolean
}

interface ScreenshotState {
  shot: ShotCapture | null
  open: (shot: ShotCapture) => void
  close: () => void
}

export const useScreenshotStore = create<ScreenshotState>((set) => ({
  shot: null,
  open: (shot) => set({ shot }),
  close: () => set({ shot: null }),
}))
