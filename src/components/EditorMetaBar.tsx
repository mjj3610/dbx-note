import { CalendarClock, Camera, FileText, Info, SlashSquare } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { openSlashMenu } from '@/lib/editorBus'
import { captureMessage, startScreenshot } from '@/lib/screenshot'
import { countWords } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useNotesStore } from '@/stores/notes'

/**
 * 编辑器顶部第二行（对齐 NoteGen 的编辑器头部）
 *
 * 左侧三个小按钮：笔记元信息、插入块（唤起斜杠命令）、截图插入；
 * 右侧只读展示当前文件路径，正文区从这一行下面开始滚动。
 */
export function EditorMetaBar() {
  const t = useT()
  const activePath = useNotesStore((state) => state.activePath)
  const content = useNotesStore((state) => state.content)
  if (!activePath) return null

  const name = activePath.split('/').pop() ?? activePath
  const folder = activePath.slice(0, Math.max(0, activePath.length - name.length - 1)) || '.'
  const headings = (content.match(/^#{1,6}\s+\S/gm) ?? []).length
  const lines = content ? content.split('\n').length : 0

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('editor.noteInfo')}
            title={t('editor.noteInfo')}
          >
            <Info className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuLabel className="flex items-center gap-1.5">
            <FileText className="size-3" />
            {t('editor.noteInfo')}
          </DropdownMenuLabel>
          <div className="space-y-1 px-2 pb-1.5 text-[11px] text-muted-foreground">
            <div className="break-all text-foreground">{name}</div>
            <div className="break-all">{folder}</div>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1.5">
              <CalendarClock className="size-3" />
              {t('editor.meta.words', { count: countWords(content) })}
            </div>
            <div>{t('editor.meta.lines', { count: lines })}</div>
            <div>{t('editor.meta.headings', { count: headings })}</div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Hint label={t('editor.insertBlock')}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('editor.insertBlock')}
          onClick={() => {
            if (!openSlashMenu()) return
          }}
        >
          <SlashSquare className="size-3.5" />
        </Button>
      </Hint>

      <Hint label={t('editor.screenshot')}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('editor.screenshot')}
          data-editor-screenshot
          onClick={() => {
            void startScreenshot().then((result) => {
              // 浮层本身就是反馈；用户主动取消也不打扰
              if (result.status === 'opened' || result.status === 'cancelled') return
              const notice = captureMessage(result)
              if (notice.tone === 'success') toast.success(t(notice.key))
              else if (notice.tone === 'warning') toast.warning(t(notice.key))
              else toast.error(result.status === 'error' ? result.message : t(notice.key))
            })
          }}
        >
          <Camera className="size-3.5" />
        </Button>
      </Hint>

      <div className="flex-1" />
      <span className="max-w-[60%] truncate text-[11px] text-muted-foreground" title={activePath}>
        {activePath}
      </span>
    </div>
  )
}
