/**
 * 编辑器内搜索 / 替换（对齐复刻项目的 search-replace-panel + search-navigation）
 *
 * - 用一个轻量 ProseMirror 插件保存「关键词 / 区分大小写 / 当前命中序号」，
 *   并据此给命中的文本挂装饰（高亮全部命中，当前命中加深）；
 * - 命中范围按 text 节点扫描，跨节点的长文本（含行内标记打断）不会命中，
 *   这与复刻项目的行为一致，也避免了跨块匹配的歧义。
 */
import { Extension, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface SearchMatch {
  from: number
  to: number
}

export interface SearchState {
  query: string
  caseSensitive: boolean
  active: number
}

const EMPTY: SearchState = { query: '', caseSensitive: false, active: 0 }

export const searchPluginKey = new PluginKey<SearchState>('dbx-search')

// 装饰函数每次 state 读取都会跑；按「文档 + 关键词」做一层缓存，避免输入卡顿
let cacheDoc: PMNode | null = null
let cacheQuery = ''
let cacheCaseSensitive = false
let cacheMatches: SearchMatch[] = []

/** 扫描文档里所有命中位置 */
export function findMatches(doc: PMNode, query: string, caseSensitive: boolean): SearchMatch[] {
  if (!query) return []
  if (cacheDoc === doc && cacheQuery === query && cacheCaseSensitive === caseSensitive) return cacheMatches
  const needle = caseSensitive ? query : query.toLowerCase()
  const found: SearchMatch[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const haystack = caseSensitive ? node.text : node.text.toLowerCase()
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      found.push({ from: pos + index, to: pos + index + needle.length })
      index = haystack.indexOf(needle, index + needle.length)
    }
  })
  cacheDoc = doc
  cacheQuery = query
  cacheCaseSensitive = caseSensitive
  cacheMatches = found
  return found
}

export const SearchReplace = Extension.create({
  name: 'dbxSearchReplace',

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchPluginKey,
        state: {
          init: () => EMPTY,
          apply(transaction, previous) {
            const meta = transaction.getMeta(searchPluginKey) as Partial<SearchState> | undefined
            if (!meta) {
              // 文档改动后命中位置会整体平移，重新回到第一个命中
              return transaction.docChanged ? { ...previous, active: 0 } : previous
            }
            return { ...previous, ...meta }
          },
        },
        props: {
          decorations(state) {
            const current = searchPluginKey.getState(state)
            if (!current?.query) return null
            const matches = findMatches(state.doc, current.query, current.caseSensitive)
            if (matches.length === 0) return null
            const active = Math.min(Math.max(0, current.active), matches.length - 1)
            return DecorationSet.create(
              state.doc,
              matches.map((match, index) =>
                Decoration.inline(match.from, match.to, {
                  class:
                    index === active
                      ? 'dbx-search-hit dbx-search-hit-active'
                      : 'dbx-search-hit',
                }),
              ),
            )
          },
        },
      }),
    ]
  },
})

/** 读取当前搜索状态与命中列表 */
export function readSearch(editor: Editor): SearchState & { matches: SearchMatch[] } {
  const state = searchPluginKey.getState(editor.state) ?? EMPTY
  return { ...state, matches: findMatches(editor.state.doc, state.query, state.caseSensitive) }
}

function patch(editor: Editor, value: Partial<SearchState>) {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, value))
}

/** 改关键词（会回到第一个命中） */
export function setSearchQuery(editor: Editor, query: string) {
  patch(editor, { query, active: 0 })
}

export function setSearchCaseSensitive(editor: Editor, caseSensitive: boolean) {
  patch(editor, { caseSensitive, active: 0 })
}

export function clearSearch(editor: Editor) {
  patch(editor, { query: '', active: 0 })
}

/** 滚动到指定命中处（不改选区，避免顶出气泡工具栏） */
export function scrollToMatch(editor: Editor, match: SearchMatch) {
  try {
    const dom = editor.view.domAtPos(match.from).node
    const element = dom.nodeType === 1 ? (dom as HTMLElement) : dom.parentElement
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch {
    // 文档刚刚变更、位置失效时忽略
  }
}

/** 切到下一个 / 上一个命中，返回新的序号 */
export function stepSearch(editor: Editor, direction: 1 | -1): number {
  const { matches, active } = readSearch(editor)
  if (matches.length === 0) return 0
  const next = (active + direction + matches.length) % matches.length
  patch(editor, { active: next })
  scrollToMatch(editor, matches[next])
  return next
}

/** 跳到绝对序号 */
export function gotoMatch(editor: Editor, index: number) {
  const { matches } = readSearch(editor)
  if (matches.length === 0) return
  const next = Math.min(Math.max(0, index), matches.length - 1)
  patch(editor, { active: next })
  scrollToMatch(editor, matches[next])
}

/** 替换当前命中 */
export function replaceCurrent(editor: Editor, replacement: string): boolean {
  const { matches, active, query } = readSearch(editor)
  if (!query || matches.length === 0) return false
  const match = matches[Math.min(Math.max(0, active), matches.length - 1)]
  editor
    .chain()
    .focus()
    .insertContentAt({ from: match.from, to: match.to }, replacement)
    .run()
  const after = readSearch(editor)
  if (after.matches.length > 0) {
    const index = Math.min(match.from > 0 ? active : 0, after.matches.length - 1)
    patch(editor, { active: index })
    scrollToMatch(editor, after.matches[index])
  }
  return true
}

/** 全部替换，返回替换次数 */
export function replaceAll(editor: Editor, replacement: string): number {
  const { matches, query } = readSearch(editor)
  if (!query || matches.length === 0) return 0
  let chain = editor.chain().focus()
  // 从后往前替换，前面的位置就不会被前一次替换挤歪
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]
    chain = chain.insertContentAt({ from: match.from, to: match.to }, replacement)
  }
  chain.run()
  patch(editor, { active: 0 })
  return matches.length
}
