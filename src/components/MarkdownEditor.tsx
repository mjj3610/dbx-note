import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { EditorEvents } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import TextAlign from '@tiptap/extension-text-align'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { Markdown } from '@tiptap/markdown'
import { FoldableHeading, HeadingFold } from '@/lib/headingFold'
import { createLowlight, common } from 'lowlight'

import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'
import { editorBus } from '@/lib/editorBus'
import { OutlineHeadingIndex } from '@/lib/outlineIndex'
import {
  deactivateEditorOutline,
  getLatestHeadings,
  publishHeadings,
  untitledHeading,
} from '@/lib/outlineStore'
import { isRemoteImage, persistImage } from '@/lib/imageStore'
import { imageMarkdown } from '@/lib/imageAttrs'
import * as rpc from '@/lib/rpc'
import {
  IMAGE_PLACEHOLDER,
  isWorkspaceImage,
  loadPreview,
  previewOf,
} from '@/lib/previewCache'
import { toast } from 'sonner'
import { ColorHighlight, TextColor } from '@/lib/colorMarks'
import { BlockMath, InlineMath } from '@/lib/mathNodes'
import { MermaidDiagram } from '@/lib/mermaidNode'
import { CodeBlockWithToolbar } from '@/lib/codeBlockView'
import { DbxTableCell, DbxTableHeader } from '@/lib/tableExtensions'
import { SearchReplace } from '@/lib/searchReplace'
import { GitHubAlert } from '@/lib/githubAlert'
import { EditorShortcuts } from '@/lib/editorShortcuts'
import { EditorToolbar } from './EditorToolbar'
import { SlashMenu } from './editor/SlashMenu'
import { SelectionAIPanel } from './editor/SelectionAIPanel'
import { BlockHandle } from './editor/BlockHandle'
import { TableFloatingBar } from './editor/TableFloatingBar'
import { SearchReplacePanel } from './editor/SearchReplacePanel'
import { BlockMathDialog } from './editor/BlockMathDialog'
import { ImageSettingPanel } from './editor/ImageSettingPanel'

const lowlight = createLowlight(common)

/** 粘贴进来的图片落到工作区 assets/ 下，正文里只留相对路径 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取剪贴板图片失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 保存粘贴进来的图片并插入到光标处
 *
 * 插入的是图片节点（markdown 序列化成 `![](assets/xxx.png)`）。
 * 走本地存储时文件落在工作区的图片目录里；配置了图床则上传后写完整 URL。
 */
async function storePastedImages(
  view: EditorView,
  files: File[],
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  for (const file of files) {
    try {
      const base64 = await fileToBase64(file)
      const saved = await persistImage({
        name: file.name || 'image.png',
        dataBase64: base64,
        mime: file.type || 'image/png',
      })
      const node = view.state.schema.nodes.image?.create({ src: saved.src, alt: '' })
      if (!node) continue
      view.dispatch(view.state.tr.replaceSelectionWith(node))
      toast.success(saved.remote ? t('image.uploaded') : t('image.saved'))
    } catch (error) {
      toast.error(
        t('toast.error', { message: error instanceof Error ? error.message : String(error) }),
      )
    }
  }
}

/**
 * 可视化编辑器（Tiptap + Markdown）
 *
 * 输入输出都是 Markdown：初值从状态读取，每次变更回写 `getMarkdown()`，
 * 因此磁盘上始终是可直接用其他编辑器打开的纯文本。
 */
export function MarkdownEditor({
  path,
  value,
  onChange,
  registerBus = true,
  readOnly = false,
}: {
  path: string
  /** 受控用法（并排对照面板）：不传则读写笔记状态 */
  value?: string
  onChange?: (markdown: string) => void
  /**
   * 是否把自身注册到 editorBus（全局插入 / 大纲跳转 / 插入块）。
   * 并排对照里的辅助编辑器传 false，避免抢走主编辑器的能力。
   */
  registerBus?: boolean
  /** 右键「只读打开」：正文可复制 / 选中，但不接受任何输入 */
  readOnly?: boolean
}) {
  const t = useT()
  const controlled = value !== undefined
  const initial = useRef(controlled ? (value as string) : useNotesStore.getState().content)
  const storeSetContent = useNotesStore((state) => state.setContent)
  const storeContent = useNotesStore((state) => state.content)
  const setContent = controlled ? (onChange ?? (() => undefined)) : storeSetContent
  const content = controlled ? (value as string) : storeContent
  // 记录编辑器自己产出的文本，用于区分"外部写入"与"用户输入"
  const emitted = useRef(initial.current)
  // 「插入块级公式」弹窗（斜杠命令 math.block 打开）
  const [mathOpen, setMathOpen] = useState(false)
  // 编辑器内搜索替换面板（Ctrl/⌘+F 打开）
  const [searchOpen, setSearchOpen] = useState(false)
  // 块手柄需要一个 relative 定位容器
  const containerRef = useRef<HTMLDivElement>(null)

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        codeBlock: false,
        link: false,
        underline: false,
        // 标题折叠用自定义 heading（folded 视图态 + 行右端折叠按钮），见 headingFold.ts
        heading: false,
      }),
      FoldableHeading,
      Underline,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener' } }),
      // 本地图片先渲染透明占位（沙箱里相对路径必然 404），拿到 data URL 后再补 src；
      // 只改 DOM 的 src，节点的 attrs.src 仍是相对路径，Markdown 序列化不受影响。
      Image.extend({
        renderHTML({ HTMLAttributes }) {
          const src = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : ''
          if (!isWorkspaceImage(src)) return ['img', HTMLAttributes]
          const cached = previewOf(src)
          return [
            'img',
            { ...HTMLAttributes, src: cached ?? IMAGE_PLACEHOLDER, 'data-src': src },
          ]
        },
        // 带尺寸的图片序列化成内联 `<img … width height>`（GFM 没有别的表达方式），
        // 无尺寸保持 `![alt](src)`；解析回来时 `parseHTML` 会把 width/height 取回属性。
        renderMarkdown: (node) => imageMarkdown((node.attrs ?? {}) as Record<string, unknown>),
      }).configure({ inline: false, allowBase64: true }),
      // 文字颜色 + 多色高亮（颜色写进 markdown 的 span/mark 标签，见 colorMarks.ts）
      TextColor,
      ColorHighlight.configure({ multicolor: true }),
      InlineMath,
      BlockMath,
      // Mermaid 图表：```mermaid 围栏 ↔ 可渲染节点（见 mermaidNode.tsx）
      MermaidDiagram,
      Placeholder.configure({ placeholder: t('editor.placeholder') }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      DbxTableHeader,
      DbxTableCell,
      CodeBlockWithToolbar.configure({ lowlight }),
      HeadingFold,
      // GitHub Alert 提示块（`> [!NOTE]` 一类引用块）
      GitHubAlert,
      // 编辑器内搜索 / 替换（Ctrl/⌘+F）与快捷键补齐（表格组 / 插入组 / 全部折叠）
      SearchReplace,
      EditorShortcuts,
      Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    ],
    [t],
  )

  const editor = useEditor(
    {
      extensions,
      content: initial.current,
      contentType: 'markdown',
      editorProps: {
        attributes: {
          class: 'tiptap',
          spellcheck: String(useSettingsStore.getState().editor.spellcheck),
        },
        // 剪贴板里的图片落到工作区或图床，正文只留相对路径 / 完整 URL
        handlePaste: (view, event) => {
          const pasted = event.clipboardData?.files
          const images = pasted ? Array.from(pasted).filter((item) => item.type.startsWith('image/')) : []
          if (images.length === 0) return false
          event.preventDefault()
          void storePastedImages(view, images, t)
          return true
        },
      },
      onUpdate: ({ editor: instance }) => {
        const markdown = instance.getMarkdown()
        emitted.current = markdown
        setContent(markdown)
      },
    },
    [path],
  )

  /** 只读模式：Tiptap 的 editable 是运行时属性，切换时同步给编辑器实例 */
  useEffect(() => {
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly)
  }, [editor, readOnly])

  /**
   * 远端图片代理渲染
   *
   * 宿主 CSP 是 `default-src 'none'`，`<img src="https://...">` 会被拦成破图。
   * 这里把图床地址经 Sidecar 取回并换成 data URL 显示，Markdown 里保留原地址。
   */
  useEffect(() => {
    if (!editor) return
    const root = editor.view.dom

    const swap = () => {
      root.querySelectorAll('img').forEach((img) => {
        // 本地图片：渲染时给了 data-src 与透明占位，这里补真实内容
        const path = img.getAttribute('data-src')
        if (path) {
          if (img.getAttribute('src')?.startsWith('data:image/') && img.getAttribute('src') !== IMAGE_PLACEHOLDER) {
            return
          }
          const cached = previewOf(path)
          if (cached) {
            img.setAttribute('src', cached)
            return
          }
          void loadPreview(path).then((dataUrl) => {
            if (dataUrl && img.isConnected) img.setAttribute('src', dataUrl)
          })
          return
        }

        const src = img.getAttribute('src') ?? ''
        if (!src || src.startsWith('data:')) return
        if (isRemoteImage(src)) {
          // 走 `loadPreview` 而不是 `resolveRemoteImage`：图床上传成功时手里其实已经有
          // 这张图的 data URL（`rememberPreview` 存进了预览缓存），直接取缓存就能显示，
          // 不必等 Sidecar 再去网上抓一次——抓不到（图床刚上传还没刷新、内网机出不去）
          // 就是用户看到的"图片裂了"。
          const cached = previewOf(src)
          if (cached) {
            img.setAttribute('src', cached)
            return
          }
          void loadPreview(src).then((dataUrl) => {
            if (dataUrl && img.isConnected) img.setAttribute('src', dataUrl)
          })
        }
      })
    }

    const observer = new MutationObserver(swap)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
    swap()
    return () => observer.disconnect()
  }, [editor])

  /**
   * 外部改动同步：AI 整理、插入笔记等场景会直接改 store，
   * 这里把差异写回编辑器（避免编辑器仍显示旧内容，随后覆盖掉外部结果）。
   */
  useEffect(() => {
    if (!editor) return
    if (content === emitted.current) return
    if (content === editor.getMarkdown()) {
      emitted.current = content
      return
    }
    emitted.current = content
    editor.commands.setContent(content, { contentType: 'markdown' })
  }, [content, editor])

  // 注册外部操作能力：AI 结果插入、大纲跳转、插入块
  //
  // 并排对照会同时存在两个编辑器实例，辅助编辑器（registerBus=false）
  // 不参与注册；卸载时也只清掉属于自己的引用。
  useEffect(() => {
    if (!editor || !registerBus) return

    const insert: NonNullable<typeof editorBus.insert> = (markdown, mode) => {
      if (mode === 'append') {
        const end = editor.state.doc.content.size
        // 必须声明 contentType，否则 `![](…)`、`# 标题` 会被当成纯文本插进去
        editor
          .chain()
          .focus()
          .insertContentAt(end, `\n\n${markdown}\n`, { contentType: 'markdown' })
          .run()
      } else {
        editor.commands.setContent(markdown, { contentType: 'markdown' })
      }
    }

    /**
     * 标题索引：对齐参考项目，直接从 ProseMirror doc 建 id / pos 索引，
     * 每次 transaction 只重扫变更区间，不再每次按键对整篇 Markdown 做 split + 正则。
     * 索引与编辑器同源，标题的 inline 语法、重复标题都不会导致点击失配。
     */
    const headingIndex = new OutlineHeadingIndex()
    const rebuildHeadings = () => {
      publishHeadings(headingIndex.rebuild(editor.state.doc, untitledHeading), 'editor')
    }
    rebuildHeadings()

    const handleTransaction = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
      try {
        publishHeadings(
          headingIndex.update(
            editor.state.doc,
            [transaction, ...appendedTransactions],
            untitledHeading,
          ),
          'editor',
        )
      } catch (error) {
        console.warn('[outline] 标题索引增量更新失败，已重建：', error)
        rebuildHeadings()
      }
    }
    editor.on('transaction', handleTransaction)

    /**
     * 大纲点击定位（参考项目 `outline.tsx::scrollToHeading`）。
     * 用索引里的 pos 直接设选区，再 nodeDOM 取真实标题元素、在明确的滚动容器里 scrollTo；
     * 任意层级 / 重复标题 / 带行内语法的标题都能命中，也避免 domAtPos 拿到文本节点
     * 或被嵌套滚动容器影响。
     */
    const scrollToHeading: NonNullable<typeof editorBus.scrollToHeading> = (headingId) => {
      const heading = getLatestHeadings().find((item) => item.id === headingId)
      if (!heading || heading.pos < 0 || editor.isDestroyed) return false
      const targetPos = heading.pos
      const doc = editor.state.doc
      if (targetPos >= doc.content.size || doc.nodeAt(targetPos)?.type.name !== 'heading') return false

      // 不让 focus 触发一次针对旧选区的竞争滚动
      editor
        .chain()
        .setTextSelection(Math.min(targetPos + 1, doc.content.size))
        .focus(undefined, { scrollIntoView: false })
        .run()

      const documentSnapshot = editor.state.doc
      requestAnimationFrame(() => {
        if (editor.isDestroyed || !editor.view.dom.isConnected || editor.state.doc !== documentSnapshot) return
        if (documentSnapshot.nodeAt(targetPos)?.type.name !== 'heading') return
        const domNode = editor.view.nodeDOM(targetPos)
        if (!(domNode instanceof HTMLElement)) return
        const scrollContainer = editor.view.dom.closest('[data-editor-viewport-root="true"]')
        if (!(scrollContainer instanceof HTMLElement)) {
          domNode.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return
        }
        const headingRect = domNode.getBoundingClientRect()
        const viewportRect = scrollContainer.getBoundingClientRect()
        const centeredTop = scrollContainer.scrollTop + headingRect.top + headingRect.height / 2
          - viewportRect.top - scrollContainer.clientTop - scrollContainer.clientHeight / 2
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)
        const top = Math.max(0, Math.min(maxScrollTop, centeredTop))
        scrollContainer.scrollTo({ top, behavior: 'smooth' })
      })
      return true
    }

    // 顶部「插入块」按钮：在光标处另起一行并输入 `/` 唤起斜杠命令
    const openSlash = () => {
      const { $from } = editor.state.selection
      const emptyLine = $from.parent.isTextblock && $from.parent.content.size === 0
      const chain = editor.chain().focus()
      if (!emptyLine) chain.splitBlock()
      chain.insertContent('/').run()
    }

    editorBus.insert = insert
    editorBus.scrollToHeading = scrollToHeading
    editorBus.openSlash = openSlash
    editorBus.openMathDialog = () => setMathOpen(true)
    editorBus.openSearch = () => setSearchOpen(true)

    return () => {
      editor.off('transaction', handleTransaction)
      // 切到源码模式 / 切换文件时先回退到 Markdown 文本大纲，面板不留空白
      deactivateEditorOutline()
      if (editorBus.insert === insert) editorBus.insert = null
      if (editorBus.scrollToHeading === scrollToHeading) editorBus.scrollToHeading = null
      if (editorBus.openSlash === openSlash) editorBus.openSlash = null
      editorBus.openMathDialog = null
      editorBus.openSearch = null
    }
  }, [editor, registerBus])

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      bold: instance?.isActive('bold') ?? false,
      italic: instance?.isActive('italic') ?? false,
      underline: instance?.isActive('underline') ?? false,
      strike: instance?.isActive('strike') ?? false,
      code: instance?.isActive('code') ?? false,
      highlight: instance?.isActive('highlight') ?? false,
      heading: instance?.isActive('heading') ?? false,
      bulletList: instance?.isActive('bulletList') ?? false,
      orderedList: instance?.isActive('orderedList') ?? false,
      taskList: instance?.isActive('taskList') ?? false,
      blockquote: instance?.isActive('blockquote') ?? false,
      link: instance?.isActive('link') ?? false,
      table: instance?.isActive('table') ?? false,
    }),
  })

  if (!editor) {
    return <div className="px-8 py-10 text-sm text-muted-foreground">{t('common.loading')}</div>
  }

  return (
    <>
      <BubbleMenu
        editor={editor}
        shouldShow={({ editor: instance, from, to }) =>
          // 选中图片时换成「图片设置」面板，避免两块浮层叠在图上
          !instance.isActive('codeBlock') &&
          !instance.isActive('image') &&
          (from !== to || instance.isActive('table'))
        }
        // 表格内改到下方：上方会被单元格行盖住，且遮住表头
        options={{ placement: state?.table ? 'bottom' : 'top', offset: 8 }}
      >
        <EditorToolbar editor={editor} state={state} />
      </BubbleMenu>
      <SlashMenu editor={editor} />
      <SelectionAIPanel editor={editor} />
      <div ref={containerRef} className="relative">
        <EditorContent editor={editor} />
        <BlockHandle editor={editor} containerRef={containerRef} />
        {state?.table ? <TableFloatingBar editor={editor} containerRef={containerRef} /> : null}
        <ImageSettingPanel editor={editor} containerRef={containerRef} />
      </div>
      <BlockMathDialog
        open={mathOpen}
        onClose={() => setMathOpen(false)}
        onInsert={(latex) => {
          editor.chain().focus().insertContent({ type: 'blockMath', attrs: { latex } }).run()
        }}
      />
      <SearchReplacePanel editor={editor} open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  )
}
