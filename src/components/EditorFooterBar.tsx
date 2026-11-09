/**
 * 编辑器底部工具栏（对齐参考项目 footer-bar 的复制 / 导出 / 大纲 / 字数 / 历史版本）
 *
 * 参考项目把「模式切换」也放在这一栏；本项目顶部标签栏已有可视化 / 源码分段控件，
 * 为避免同一屏出现两个入口，这里不重复放模式按钮，其余项保持一致的语义与顺序。
 *
 * 内容源统一取 `useNotesStore.content`：可视化编辑器 onUpdate 会回写 getMarkdown()，
 * 源码模式也用同一份，所以复制 / 导出拿到的永远是当前最新正文。
 */
import { useMemo, useState } from 'react'
import { Copy, Download, ListTree, Type } from 'lucide-react'
import { toast } from 'sonner'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { copyText } from '@/lib/bridge'
import {
  buildHtmlDocument,
  contentForCopy,
  contentForExport,
  downloadText,
  exportBaseName,
  printPdf,
  renderMarkdownHtml,
  type CopyFormat,
  type ExportFormat,
} from '@/lib/markdownExport'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'
import { HistoryMenu } from './editor/HistoryMenu'

/** 底栏按钮的统一外观（浅色 / 深色主题都跟随 muted 前景色） */
const FOOTER_BUTTON_CLASS =
  'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors ' +
  'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/** 复制菜单的 4 种格式，顺序与参考项目一致 */
const COPY_FORMATS: CopyFormat[] = ['markdown', 'html', 'json', 'text']
/** 导出菜单的 4 种格式，PDF 走系统打印窗口 */
const EXPORT_FORMATS: ExportFormat[] = ['markdown', 'html', 'json', 'pdf']

/** 把未知异常转成可展示文案 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 复制：把当前笔记按指定格式写入系统剪贴板（优先宿主能力，降级浏览器 API） */
function CopyMenu({ markdown }: { markdown: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)

  const runCopy = async (format: CopyFormat) => {
    setBusy(true)
    try {
      const ok = await copyText(contentForCopy(format, markdown))
      if (!ok) throw new Error('clipboard unavailable')
      toast.success(t('footer.copySuccess', { format: t(`footer.format.${format}`) }))
    } catch (error) {
      toast.error(t('footer.copyFailed', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={FOOTER_BUTTON_CLASS} data-footer-copy title={t('footer.copy')}>
          <Copy className="size-3" />
          {t('footer.copy')}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        {COPY_FORMATS.map((format) => (
          <DropdownMenuItem
            key={format}
            disabled={busy}
            data-copy-format={format}
            onSelect={() => void runCopy(format)}
          >
            {t(`footer.format.${format}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 导出：Markdown / HTML / JSON 直接下载，PDF 打开系统打印窗口 */
function ExportMenu({ markdown, path }: { markdown: string; path: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)

  const runExport = async (format: ExportFormat) => {
    setBusy(true)
    try {
      if (format === 'pdf') {
        const html = buildHtmlDocument(exportBaseName(path), renderMarkdownHtml(markdown))
        if (await printPdf(html)) {
          toast.success(t('footer.exportPdfHint'))
        } else {
          // 沙箱禁掉 iframe 打印时不能静默失败：退化为 HTML，用户可在浏览器里打印成 PDF
          const fallback = contentForExport('html', markdown, path)
          downloadText(fallback.filename, fallback.content, fallback.mime)
          toast.message(t('footer.exportPdfFallback'))
        }
        return
      }
      const file = contentForExport(format, markdown, path)
      downloadText(file.filename, file.content, file.mime)
      toast.success(t('footer.exportSuccess', { filename: file.filename }))
    } catch (error) {
      toast.error(t('footer.exportFailed', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={FOOTER_BUTTON_CLASS}
          data-footer-export
          disabled={busy}
          title={t('footer.export')}
        >
          <Download className="size-3" />
          {t('footer.export')}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        {EXPORT_FORMATS.map((format) => (
          <DropdownMenuItem
            key={format}
            disabled={busy}
            data-export-format={format}
            onSelect={() => void runExport(format)}
          >
            {t(`footer.format.${format}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 编辑器底栏；没有打开笔记时不渲染 */
export function EditorFooterBar() {
  const t = useT()
  const activePath = useNotesStore((state) => state.activePath)
  const content = useNotesStore((state) => state.content)
  const tab = useUiStore((state) => state.tab)
  const chars = useMemo(() => content.replace(/\s+/g, '').length, [content])

  /** 大纲：复用左侧栏页签，左栏被收起时先展开 */
  const toggleOutline = () => {
    const state = useUiStore.getState()
    const isOutlineVisible = state.leftVisible && state.tab === 'outline'
    if (!state.leftVisible) state.toggleLeft()
    state.setTab(isOutlineVisible ? 'files' : 'outline')
  }

  if (!activePath) return null

  return (
    <footer
      data-editor-footer
      className="flex h-7 min-h-7 shrink-0 items-center gap-1 border-t border-border bg-background px-2.5 text-[11px] text-muted-foreground"
    >
      <CopyMenu markdown={content} />
      <ExportMenu markdown={content} path={activePath} />

      <button
        type="button"
        className={FOOTER_BUTTON_CLASS}
        data-footer-outline
        aria-pressed={tab === 'outline'}
        title={t('footer.outline')}
        onClick={toggleOutline}
      >
        <ListTree className="size-3" />
        {t('footer.outline')}
      </button>

      <span className="flex shrink-0 items-center gap-1 px-1" data-footer-chars>
        <Type className="size-3" />
        {t('ed.stats.chars', { count: chars })}
      </span>

      <span className="flex-1" />
      <HistoryMenu path={activePath} markdown={content} />
    </footer>
  )
}
