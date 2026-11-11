import { useSyncExternalStore } from 'react'

import { translate } from './i18n'
import { headingsFromMarkdown, type HeadingItem } from './outlineIndex'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'

/**
 * 大纲外部 store
 *
 * 不把 Tiptap editor 或标题数组塞进 zustand 全局 store：
 * 编辑器只把索引结果发布到这里，大纲面板用 `useSyncExternalStore` 订阅，
 * 其余订阅 `content` 的组件（写作统计、保存态……）不会被大纲牵连重渲染。
 */
export type OutlineSource = 'editor' | 'markdown'

export interface OutlineSnapshot {
  headings: HeadingItem[]
  source: OutlineSource
}

export function untitledHeading(level: number): string {
  return translate(useSettingsStore.getState().locale, 'outline.untitled', { level })
}

let snapshot: OutlineSnapshot = { headings: [], source: 'markdown' }
/** 始终持有最新索引（含每次编辑后变化的位置），点击定位从这里取，而不是渲染快照 */
let latest: HeadingItem[] = []
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): OutlineSnapshot {
  return snapshot
}

function emit(): void {
  for (const listener of listeners) listener()
}

/** 只有 id / 层级 / 文案变化才算「大纲内容变化」 */
function sameContent(a: HeadingItem[], b: HeadingItem[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => {
    const next = b[index]
    return (
      item.id === next.id
      && item.level === next.level
      && item.rawText === next.rawText
      && item.text === next.text
    )
  })
}

/**
 * 发布标题索引。
 *
 * 对齐参考项目 `publishHeadings`：正文编辑只让后续标题的 pos 平移，
 * 这种情况只更新 latest、不换 snapshot 引用，避免每次按键重渲染整个大纲。
 */
export function publishHeadings(headings: HeadingItem[], source: OutlineSource): void {
  latest = headings
  if (snapshot.source === source && sameContent(snapshot.headings, headings)) return
  snapshot = { headings, source }
  emit()
}

/** 源码模式：直接用当前 Markdown 文本兜底大纲 */
export function publishMarkdownHeadings(markdown: string): void {
  publishHeadings(headingsFromMarkdown(markdown, untitledHeading), 'markdown')
}

/** 主编辑器卸载（切源码 / 切文件）时先回退到文本大纲，避免面板空白 */
export function deactivateEditorOutline(): void {
  publishMarkdownHeadings(useNotesStore.getState().content)
}

/** 供点击定位取最新 pos；渲染请用 `useOutline()` */
export function getLatestHeadings(): HeadingItem[] {
  return latest
}

export function getOutlineSnapshot(): OutlineSnapshot {
  return snapshot
}

export function useOutline(): OutlineSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
