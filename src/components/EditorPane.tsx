import { useEffect, useMemo, useState } from 'react'
import {
  Code2,
  Eye,
  FileText,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Save,
  Trash2,
  Pencil,
  FolderOpen,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/misc'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { useT } from '@/lib/useT'
import { scrollToHeading } from '@/lib/editorBus'
import { getLatestHeadings, publishMarkdownHeadings } from '@/lib/outlineStore'
import { toggleSidePane } from '@/lib/split'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { EditorFooterBar } from './EditorFooterBar'
import { EditorMetaBar } from './EditorMetaBar'
import { EditorTabBar } from './EditorTabBar'
import { MarkdownEditor } from './MarkdownEditor'
import { OutlinePanel } from './OutlinePanel'
import { SourceEditor } from './SourceEditor'

/**
 * 中间编辑区：标签栏 + 可视化/源码两种模式
 */
export function EditorPane() {
  const t = useT()
  const activePath = useNotesStore((state) => state.activePath)
  const tabs = useNotesStore((state) => state.tabs)
  const content = useNotesStore((state) => state.content)
  const setContent = useNotesStore((state) => state.setContent)
  const loadingFile = useNotesStore((state) => state.loadingFile)
  const saveState = useNotesStore((state) => state.saveState)
  const save = useNotesStore((state) => state.save)

  const startRename = useUiStore((state) => state.startRename)
  const confirmDelete = useUiStore((state) => state.confirmDelete)
  const setDirPickerOpen = useUiStore((state) => state.setDirPickerOpen)
  const sidePane = useUiStore((state) => state.sidePane)
  const readOnlyPaths = useUiStore((state) => state.readOnlyPaths)
  const readOnly = Boolean(activePath && readOnlyPaths.includes(activePath))

  const [mode, setMode] = useState<'visual' | 'source'>('visual')
  /** 编辑方式与源码显示偏好取自设置页（与 NoteGen 的默认编辑模式一致） */
  const editorSettings = useSettingsStore((state) => state.editor)
  const patchSettings = useSettingsStore((state) => state.patch)

  /** 大纲在编辑器内显示时，按设置贴在左/右侧 */
  const inlineOutline =
    editorSettings.outlinePlacement === 'editor' && editorSettings.outlineEnabled
      ? editorSettings.outlinePosition
      : null
  /** 显示写作统计：字数与预计阅读时长 */
  const stats = useMemo(() => {
    const text = content.replace(/\s+/g, '')
    return { chars: text.length, minutes: Math.max(1, Math.ceil(text.length / 350)) }
  }, [content])

  /** 切换编辑方式：同时记为默认模式，下次打开直接沿用 */
  const changeMode = (next: 'visual' | 'source') => {
    setMode(next)
    if (next !== editorSettings.viewMode) {
      patchSettings({ editor: { ...editorSettings, viewMode: next } })
    }
  }

  /** 打开/关闭并排对照，规则与快捷键共用 */
  const toggleSide = () => {
    const opened = toggleSidePane()
    if (opened && opened === activePath) toast.message(t('side.sameFile'))
  }

  // 切换文件时回到默认编辑模式，符合"打开即阅读"的预期
  useEffect(() => {
    setMode(useSettingsStore.getState().editor.viewMode)
  }, [activePath])

  // 源码模式没有 Tiptap 实例，大纲改用 Markdown 文本兜底解析
  useEffect(() => {
    if (mode !== 'source') return
    publishMarkdownHeadings(activePath ? content : '')
  }, [mode, content, activePath])

  // 大纲点击 → 编辑器按标题 id 定位；源码模式降级为按行号跳到 CodeMirror
  useEffect(() => {
    const handler = (event: Event) => {
      const headingId = (event as CustomEvent<string>).detail
      if (!headingId || scrollToHeading(headingId)) return
      const heading = getLatestHeadings().find((item) => item.id === headingId)
      if (heading?.line === undefined) return
      window.dispatchEvent(new CustomEvent('dbx-note:scroll-to-line', { detail: heading.line }))
    }
    window.addEventListener('dbx-note:scroll-to-heading', handler)
    return () => window.removeEventListener('dbx-note:scroll-to-heading', handler)
  }, [])

  if (!activePath) {
    // 标签栏必须常驻：关闭当前标签后异步接管邻居的那段时间里，tabs 仍非空，
    // 不能把整棵编辑器子树（含标签栏）卸载掉，否则表现为「其他 tab 先消失再回来」。
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <EditorTabBar />
        {tabs.length > 0 ? (
          // 正在读盘接管邻居笔记，用加载态占位而不是「没有打开文件」的空状态
          <div className="flex min-h-0 flex-1 items-center justify-center" data-editor-switching="1">
            <Spinner className="text-muted-foreground" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <FileText className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">{t('editor.noFile')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('editor.noFileHint')}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setDirPickerOpen(true)}>
              <FolderOpen className="size-3.5" />
              {t('settings.workspace')}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <EditorTabBar>
        {readOnly ? (
          <button
            type="button"
            className="mr-1 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            data-editor-readonly="1"
            title={t('editor.exitReadOnly')}
            onClick={() => useUiStore.getState().setReadOnly(activePath, false)}
          >
            {t('editor.readOnly')}
          </button>
        ) : null}
        <span className="mr-1 shrink-0 text-[11px] text-muted-foreground">
          {saveState === 'saving' ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              {t('editor.saving')}
            </span>
          ) : saveState === 'error' ? (
            <span className="text-destructive">{t('editor.unsaved')}</span>
          ) : content === '' ? null : (
            t('editor.saved')
          )}
        </span>

        {editorSettings.showStats && content !== '' ? (
          <span className="mr-1 shrink-0 text-[11px] text-muted-foreground" data-editor-stats="1">
            {t('ed.stats.chars', { count: stats.chars })} · {t('ed.stats.reading', { count: stats.minutes })}
          </span>
        ) : null}

        <div className="flex items-center rounded-md bg-muted/60 p-0.5">
          <button
            type="button"
            onClick={() => changeMode('visual')}
            className={`flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors ${
              mode === 'visual' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            <Eye className="size-3" />
            {t('editor.visual')}
          </button>
          <button
            type="button"
            onClick={() => changeMode('source')}
            className={`flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors ${
              mode === 'source' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            <Code2 className="size-3" />
            {t('editor.source')}
          </button>
        </div>

        <Hint label={t('side.toggle')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('side.toggle')}
            aria-pressed={Boolean(sidePane)}
            className={sidePane ? 'text-primary' : undefined}
            onClick={toggleSide}
          >
            <PanelRight className="size-4" />
          </Button>
        </Hint>

        <Hint label={readOnly ? t('editor.readOnly') : t('common.save')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.save')}
            disabled={readOnly}
            onClick={() => {
              void save({ force: true }).catch((error) =>
                toast.error(t('files.saveFailed', { message: error.message })),
              )
            }}
          >
            <Save className="size-4" />
          </Button>
        </Hint>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('common.more')}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => startRename(activePath)}>
              <Pencil />
              {t('common.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDirPickerOpen(true)}>
              <FolderOpen />
              {t('settings.workspace')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
              onSelect={() => confirmDelete(activePath)}
            >
              <Trash2 />
              {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </EditorTabBar>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {mode === 'visual' ? <EditorMetaBar /> : null}
        {loadingFile ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="text-muted-foreground" />
          </div>
        ) : mode === 'visual' ? (
          <div className="flex min-h-0 flex-1">
            {inlineOutline === 'left' ? (
              <aside
                aria-label={t('outline.title')}
                className="w-40 shrink-0 overflow-hidden border-r border-border"
              >
                <OutlinePanel />
              </aside>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto" data-editor-viewport-root="true">
              <div
                className="mx-auto w-full pl-14 pr-8 pt-6"
                style={{ maxWidth: 'var(--dbx-note-editor-width, 760px)' }}
              >
                <MarkdownEditor key={activePath} path={activePath} readOnly={readOnly} />
              </div>
            </div>
            {inlineOutline === 'right' ? (
              <aside
                aria-label={t('outline.title')}
                className="w-40 shrink-0 overflow-hidden border-l border-border"
              >
                <OutlinePanel />
              </aside>
            ) : null}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <SourceEditor
              value={content}
              onChange={setContent}
              lineNumbers={editorSettings.showSourceLineNumbers}
              wrap={editorSettings.sourceWrap}
              readOnly={readOnly}
            />
          </div>
        )}
      </div>

      <EditorFooterBar />
    </div>
  )
}
