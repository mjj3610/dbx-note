/**
 * 标题折叠（对齐参考实现的「折叠此标题内容」）
 *
 * 做法：
 * 1. 扩展 heading 加 `folded` attr（不进 Markdown——序列化时忽略，
 *    切换不会把文档改脏；重新打开笔记时还原为全展开，与多数编辑器一致）；
 * 2. 一个 ProseMirror 插件按 `folded` 把「标题 → 下一个同级/更高级标题」之间的
 *    节点用 Decoration 藏起来（不动文档本身），起点放一条「已折叠 N 块」提示条；
 * 3. heading 的 NodeView 在标题行右端渲染折叠按钮：展开箭头朝下、折叠朝右（旋转 90°），
 *    常显（不依赖 hover 才发现），折叠后高亮成主题色，悬浮提示「折叠此标题内容 / 展开」。
 */
import { Extension, type Editor } from '@tiptap/core'
import Heading from '@tiptap/extension-heading'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/** 命令类型声明（让 `editor.commands.toggleHeadingFold()` 有类型） */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggleHeadingFold: {
      /** 折叠/展开光标所在的标题段落 */
      toggleHeadingFold: () => ReturnType
    }
  }
}

export const headingFoldKey = new PluginKey('dbx-heading-fold')

/**
 * 全部折叠 / 全部展开（对齐复刻项目 Ctrl/⌘+Alt+↑ / ↓）
 *
 * 只改 `folded` 视图态属性，不动正文；返回是否真的发生了改动。
 */
export function setAllHeadingsFolded(editor: Editor, folded: boolean): boolean {
  if (editor.isDestroyed) return false
  const { state, view } = editor
  const transaction = state.tr
  let changed = false
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return
    if (Boolean(node.attrs.folded) === folded) return
    transaction.setNodeMarkup(pos, undefined, { ...node.attrs, folded })
    changed = true
  })
  if (changed) view.dispatch(transaction)
  return changed
}

/** 是否还有未折叠的标题（用于按钮态） */
export function hasExpandedHeading(editor: Editor): boolean {
  if (editor.isDestroyed) return false
  let found = false
  editor.state.doc.descendants((node) => {
    if (found) return false
    if (node.type.name === 'heading' && !node.attrs.folded) found = true
    return true
  })
  return found
}

/** 标题的折叠区间终点：下一个同级/更高级标题的位置，没有则到文档尾 */
function foldRangeEnd(doc: PMNode, headingPos: number): number {
  const heading = doc.nodeAt(headingPos)
  if (!heading) return doc.content.size
  const level = Number(heading.attrs.level ?? 1)
  const after = headingPos + heading.nodeSize
  let end = doc.content.size
  doc.nodesBetween(after, doc.content.size, (node, position) => {
    if (position <= after) return true
    if (node.type.name === 'heading' && Number(node.attrs.level ?? 6) <= level) {
      end = position
      return false
    }
    return true
  })
  return end
}

/** 视图层装饰：折叠标题加标记、内容隐藏、起点放提示条 */
function buildDecorations(doc: PMNode): DecorationSet {
  const items: Decoration[] = []
  doc.descendants((node, position) => {
    if (node.type.name !== 'heading' || !node.attrs.folded) return
    const start = position + node.nodeSize
    const end = foldRangeEnd(doc, position)
    if (end <= start) return
    items.push(
      Decoration.node(position, position + node.nodeSize, {
        'data-folded-heading': 'true',
      }),
    )
    // widget 在隐藏区间起点渲染提示条（点击展开）
    items.push(
      Decoration.widget(start, () => {
        const element = document.createElement('div')
        const blocks = countTopBlocks(doc, start, end)
        element.className =
          'dbx-fold-placeholder my-1 select-none rounded-md border border-dashed border-border px-3 py-1.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground cursor-pointer'
        element.dataset.foldPlaceholder = 'true'
        element.textContent = `▸ 已折叠 ${blocks} 个内容块，点击展开`
        element.addEventListener('mousedown', (event) => {
          event.preventDefault()
        })
        return element
      }),
    )
    // 区间内每个顶层节点单独加隐藏装饰：node decoration 只作用于单个节点，
    // 一个跨多块的范围装饰只会命中第一块
    let cursor = start
    while (cursor < end) {
      const block = doc.nodeAt(cursor)
      if (!block) break
      items.push(
        Decoration.node(cursor, cursor + block.nodeSize, { class: 'dbx-fold-hidden' }),
      )
      cursor += block.nodeSize
    }
  })
  return DecorationSet.create(doc, items)
}

/** 折叠区间里的顶层内容块数（提示文案用） */
function countTopBlocks(doc: PMNode, start: number, end: number): number {
  let blocks = 0
  let cursor = start
  while (cursor < end) {
    const node = doc.nodeAt(cursor)
    if (!node) break
    blocks += 1
    cursor += node.nodeSize
  }
  return Math.max(1, blocks)
}

/** 隐藏折叠内容的样式（一次性注入） */
const FOLD_STYLE = `
.dbx-fold-hidden { display: none !important; }
`

/** 带折叠按钮的 heading：在官方扩展上加 folded 属性与 NodeView（保留输入规则等全部原生行为） */
export const FoldableHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // 纯视图状态：解析恒为 false，不序列化进 Markdown
      folded: {
        default: false,
        parseHTML: () => false,
        renderHTML: () => ({}),
      },
    }
  },

  addCommands() {
    return {
      ...this.parent?.(),
      toggleHeadingFold:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection
          // 找到光标所在/最近的标题
          let headingPos = -1
          for (let depth = $from.depth; depth >= 0; depth -= 1) {
            const node = $from.node(depth)
            if (node.type.name === 'heading') {
              headingPos = $from.before(depth)
              break
            }
          }
          if (headingPos < 0) return false
          const node = state.doc.nodeAt(headingPos)
          if (!node) return false
          if (dispatch) {
            dispatch(
              state.tr.setNodeMarkup(headingPos, undefined, {
                ...node.attrs,
                folded: !node.attrs.folded,
              }),
            )
          }
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-[': () => this.editor.commands.toggleHeadingFold(),
    }
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      // 外层与内容都用真实级别的 heading 标签：
      // 标题字号样式与 `.ProseMirror h1` 这类选择器全靠原生标签，不能换成 div
      const level = Math.min(6, Math.max(1, Number(node.attrs.level ?? 1)))
      const tag = `h${level}`

      const row = document.createElement(tag)
      // 右侧留出按钮位，长标题不会压到折叠按钮下面
      row.className = 'dbx-heading-row group relative pr-8'

      // 内容用 span（display:block）：标签语义由外层承担，`.ProseMirror h1`
      // 这类选择器只命中一次，样式（字号/字重）从外层 heading 继承
      const content = document.createElement('span')
      content.className = 'dbx-heading-content block'
      row.appendChild(content)

      const button = document.createElement('button')
      button.type = 'button'
      button.contentEditable = 'false'
      button.dataset.foldButton = 'true'
      // 常显（不靠 hover 才发现）：小圆角按钮 + 实边框 + 底色，hover 加深；
      // 折叠后高亮成主题色，提示「这里藏着内容」
      button.className =
        'dbx-fold-btn absolute right-0 top-[0.3em] flex size-5 items-center justify-center rounded-md border border-border bg-background text-foreground/65 shadow-sm transition hover:border-primary/60 hover:bg-muted hover:text-foreground'
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('viewBox', '0 0 16 16')
      icon.setAttribute('aria-hidden', 'true')
      icon.setAttribute('class', 'size-3.5 transition-transform')
      icon.innerHTML =
        '<path d="M4 6.5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'
      button.appendChild(icon)
      row.appendChild(button)

      const sync = (target: PMNode) => {
        const folded = Boolean(target.attrs.folded)
        // 折叠：箭头转向右，并换成主题色高亮
        icon.style.transform = folded ? 'rotate(-90deg)' : ''
        button.title = folded ? '展开此标题内容' : '折叠此标题内容'
        button.setAttribute('aria-label', folded ? '展开此标题内容' : '折叠此标题内容')
        button.setAttribute('aria-expanded', folded ? 'false' : 'true')
        button.classList.toggle('border-primary/60', folded)
        button.classList.toggle('bg-primary/10', folded)
        button.classList.toggle('text-primary', folded)
      }
      sync(node)

      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (editor.isDestroyed) return
        const position = typeof getPos === 'function' ? getPos() : getPos
        if (typeof position !== 'number') return
        const current = editor.state.doc.nodeAt(position)
        if (!current) return
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(position, undefined, {
            ...current.attrs,
            folded: !current.attrs.folded,
          }),
        )
      })

      return {
        dom: row,
        contentDOM: content,
        // 标题层级变化（h1 ↔ h2）时标签要跟着换，NodeView 无法原地改标签 → 返回 false 让 PM 重建
        update: (next: PMNode) => {
          if (next.type.name !== 'heading') return false
          const nextLevel = Math.min(6, Math.max(1, Number(next.attrs.level ?? 1)))
          if (nextLevel !== level) return false
          sync(next)
          return true
        },
        ignoreMutation: (mutation: { type: string; target?: unknown }) => {
          if (mutation.type !== 'attributes') return false
          const target = mutation.target as HTMLElement | undefined
          return target?.dataset?.foldButton === 'true'
        },
      }
    }
  },
})

/** 全局插件：按 folded 标记隐藏内容并放提示条 */
export const HeadingFold = Extension.create({
  name: 'headingFold',

  addProseMirrorPlugins() {
    if (!document.getElementById('dbx-heading-fold-style')) {
      const style = document.createElement('style')
      style.id = 'dbx-heading-fold-style'
      style.textContent = FOLD_STYLE
      document.head.appendChild(style)
    }
    return [
      new Plugin({
        key: headingFoldKey,
        state: {
          init: (_, state) => buildDecorations(state.doc),
          apply: (transaction) => buildDecorations(transaction.doc),
        },
        props: {
          decorations: (state) => headingFoldKey.getState(state) as DecorationSet,
        },
      }),
    ]
  },
})
