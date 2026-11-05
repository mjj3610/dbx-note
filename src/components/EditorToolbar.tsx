import { useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  Bold,
  Code,
  Eraser,
  Grid2x2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react'

import { ColorMenu } from '@/components/editor/ColorMenu'
import { SelectionAIMenu } from '@/components/editor/SelectionAIMenu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'

interface ToolbarState {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  highlight: boolean
  heading: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  blockquote: boolean
  link: boolean
  /** 光标在表格内：显示增删行列与列对齐 */
  table: boolean
}

/**
 * 选中文本后浮出的格式工具条
 *
 * 所有按钮 onMouseDown 阻止默认行为，避免编辑器失焦丢失选区。
 */
export function EditorToolbar({ editor, state }: { editor: Editor; state: ToolbarState | null }) {
  const t = useT()
  const showUndoRedo = useSettingsStore((state) => state.editor.showUndoRedo)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')

  const run = (action: () => void) => (event: React.MouseEvent) => {
    event.preventDefault()
    action()
  }

  const applyLink = () => {
    const href = linkValue.trim()
    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
    } else {
      const normalized = /^[a-z]+:\/\//i.test(href) ? href : `https://${href}`
      editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run()
    }
    setLinkOpen(false)
    setLinkValue('')
  }

  return (
    <div
      data-editor-toolbar
      className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      {/* 选区 AI：润色 / 精简 / 扩展 / 生成画布 / 翻译（对齐 NoteGen 气泡工具条的首位按钮） */}
      <SelectionAIMenu editor={editor} />
      <ToolButton
        active={state?.bold}
        label={t('editor.bold')}
        onClick={run(() => editor.chain().focus().toggleBold().run())}
      >
        <Bold className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={state?.italic}
        label={t('editor.italic')}
        onClick={run(() => editor.chain().focus().toggleItalic().run())}
      >
        <Italic className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={state?.underline}
        label={t('editor.underline')}
        onClick={run(() => editor.chain().focus().toggleUnderline().run())}
      >
        <UnderlineIcon className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={state?.strike}
        label={t('editor.strike')}
        onClick={run(() => editor.chain().focus().toggleStrike().run())}
      >
        <Strikethrough className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={state?.code}
        label={t('editor.code')}
        onClick={run(() => editor.chain().focus().toggleCode().run())}
      >
        <Code className="size-3.5" />
      </ToolButton>
      {/* 字体颜色 / 高亮颜色（对齐 NoteGen 气泡工具条上的两枚色板入口） */}
      <ColorMenu editor={editor} />
      <ColorMenu editor={editor} highlight />
      <ToolButton
        active={false}
        label={t('editor.clearFormatting')}
        onClick={run(() => editor.chain().focus().unsetAllMarks().run())}
      >
        <Eraser className="size-3.5" />
      </ToolButton>

      <Divider />

      <ToolButton
        active={editor.isActive('heading', { level: 1 })}
        label={t('editor.h1')}
        onClick={run(() => editor.chain().focus().toggleHeading({ level: 1 }).run())}
      >
        <Heading1 className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive('heading', { level: 2 })}
        label={t('editor.h2')}
        onClick={run(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
      >
        <Heading2 className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive('heading', { level: 3 })}
        label={t('editor.h3')}
        onClick={run(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
      >
        <Heading3 className="size-3.5" />
      </ToolButton>

      <Divider />

      <ToolButton
        active={state?.bulletList}
        label={t('editor.bulletList')}
        onClick={run(() => editor.chain().focus().toggleBulletList().run())}
      >
        <List className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={state?.orderedList}
        label={t('editor.orderedList')}
        onClick={run(() => editor.chain().focus().toggleOrderedList().run())}
      >
        <ListOrdered className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={state?.taskList}
        label={t('editor.taskList')}
        onClick={run(() => editor.chain().focus().toggleTaskList().run())}
      >
        <ListChecks className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={state?.blockquote}
        label={t('editor.quote')}
        onClick={run(() => editor.chain().focus().toggleBlockquote().run())}
      >
        <Quote className="size-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive('codeBlock')}
        label={t('editor.codeBlock')}
        onClick={run(() => editor.chain().focus().toggleCodeBlock().run())}
      >
        <SquareCode className="size-3.5" />
      </ToolButton>

      {/* 表格操作移到浮动工具栏（TableFloatingBar，对齐 NoteGen 的 table-toolbar）；
          这里只留插入表格入口 */}
      <>
        <Divider />
        <ToolButton
          active={false}
          label={t('editor.table')}
          onClick={run(() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
          )}
        >
          <Grid2x2 className="size-3.5" />
        </ToolButton>
      </>

      {showUndoRedo ? (
        <>
          <Divider />
          <ToolButton
            active={false}
            label={t('editor.undo')}
            onClick={run(() => editor.chain().focus().undo().run())}
          >
            <Undo2 className="size-3.5" />
          </ToolButton>
          <ToolButton
            active={false}
            label={t('editor.redo')}
            onClick={run(() => editor.chain().focus().redo().run())}
          >
            <Redo2 className="size-3.5" />
          </ToolButton>
        </>
      ) : null}

      <Divider />

      <Popover
        open={linkOpen}
        onOpenChange={(open) => {
          setLinkOpen(open)
          if (open) setLinkValue(editor.getAttributes('link').href ?? '')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(toolClass, state?.link && 'bg-muted text-foreground')}
            title={t('editor.link')}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Link2 className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" onOpenAutoFocus={(event) => event.preventDefault()}>
          <Input
            autoFocus
            value={linkValue}
            onChange={(event) => setLinkValue(event.target.value)}
            placeholder={t('editor.linkPrompt')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                applyLink()
              }
            }}
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setLinkOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="xs" onClick={applyLink}>
              {t('common.apply')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

const toolClass =
  'flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

function ToolButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean
  label: string
  onClick: (event: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      onMouseDown={onClick}
      className={cn(toolClass, active && 'bg-muted text-foreground')}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-border" />
}
