/**
 * 块手柄（对齐 NoteGen 的 `BlockHandleControls`）
 *
 * 鼠标移到某个顶层块上时，左侧浮出「⠿ 拖动手柄 + 加号」：
 * - `⠿` 打开菜单：复制内容 / 复制 Markdown / 创建副本 / 上移 / 下移 / 转换为 › / 清除格式 / 删除；
 * - `+` 在块下方插入空段落并聚焦。
 *
 * 位置用容器坐标系计算（`containerRef` 必须是 `relative`），滚动与窗口变化都不需要额外监听。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  ArrowDown,
  ArrowUp,
  ClipboardCopy,
  CodeXml,
  Copy,
  Eraser,
  GripVertical,
  Pilcrow,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { openSlashMenu } from '@/lib/editorBus'
import {
  addBlockBelow,
  blockAt,
  blockMarkdown,
  clearBlockFormatting,
  conversionTypeOf,
  convertBlock,
  copyBlockContent,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  type BlockConversionType,
  type BlockInfo,
} from '@/lib/blockActions'
import { useT } from '@/lib/useT'

/**
 * 鼠标离开正文到手柄的「过桥时间」
 *
 * 手柄渲染在 container 左侧装订线里（left: -46），鼠标从正文移向 `+` 时
 * 会先短暂离开 container 的命中区域，触发 `mouseleave`。参考项目用几何过桥带
 * + 状态锁处理，这里用「延迟隐藏 + 进入手柄即取消」达到同样效果：
 * 延迟期间 info 仍在，按钮保持 pointer-events: auto，鼠标能真正落到按钮上。
 */
const HANDLE_HIDE_DELAY_MS = 280
/** 手柄右侧的透明桥接带宽度（px），补齐手柄与正文之间的空隙 */
const HANDLE_BRIDGE_WIDTH_PX = 6

export function BlockHandle({
  editor,
  containerRef,
}: {
  editor: Editor
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const t = useT()
  const [info, setInfo] = useState<BlockInfo | null>(null)
  const [top, setTop] = useState(0)
  const [open, setOpen] = useState(false)
  const activeRef = useRef<BlockInfo | null>(null)
  const openRef = useRef(false)
  /** 延迟隐藏句柄；鼠标回到正文或手柄时取消 */
  const hideTimerRef = useRef<number | null>(null)

  openRef.current = open

  /** 取消待执行的隐藏，手柄保持可点击 */
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  /** 延迟隐藏：给鼠标穿过装订线的时间，避免按钮瞬间消失 */
  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      activeRef.current = null
      setInfo(null)
    }, HANDLE_HIDE_DELAY_MS)
  }, [cancelHide])

  const locate = useCallback(
    (target: EventTarget | null) => {
      const container = containerRef.current
      const root = editor.isDestroyed ? null : editor.view.dom
      if (!container || !root) return
      const element = target instanceof HTMLElement ? target : null
      if (!element || !root.contains(element)) return
      let block: HTMLElement | null = element
      while (block && block.parentElement !== root) block = block.parentElement
      if (!block) return
      const next = blockAt(editor, block)
      if (!next) return
      const blockRect = block.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      activeRef.current = next
      setInfo(next)
      setTop(blockRect.top - containerRect.top + Math.min(6, blockRect.height / 2 - 10))
    },
    [containerRef, editor],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onMove = (event: MouseEvent) => {
      if (openRef.current) return
      // 鼠标仍在编辑器区域（含手柄）就取消待隐藏，保持按钮可点
      cancelHide()
      locate(event.target)
    }
    const onLeave = () => {
      if (openRef.current) return
      scheduleHide()
    }
    container.addEventListener('mousemove', onMove)
    container.addEventListener('mouseleave', onLeave)
    return () => {
      container.removeEventListener('mousemove', onMove)
      container.removeEventListener('mouseleave', onLeave)
    }
  }, [cancelHide, containerRef, locate, scheduleHide])

  // 组件卸载时清掉定时器，避免对已卸载组件 setState
  useEffect(() => () => cancelHide(), [cancelHide])

  if (editor.isDestroyed) return null

  const run = (action: (target: BlockInfo) => void) => () => {
    const target = activeRef.current
    if (!target) return
    action(target)
  }

  const current = info ? conversionTypeOf(info.node) : 'paragraph'
  const conversions: Array<{ value: BlockConversionType; label: string }> = [
    { value: 'paragraph', label: t('editor.block.paragraph') },
    { value: 'heading1', label: t('editor.h1') },
    { value: 'heading2', label: t('editor.h2') },
    { value: 'heading3', label: t('editor.h3') },
    { value: 'heading4', label: t('editor.h4') },
    { value: 'heading5', label: t('editor.h5') },
    { value: 'heading6', label: t('editor.h6') },
    { value: 'bulletList', label: t('editor.bulletList') },
    { value: 'orderedList', label: t('editor.orderedList') },
    { value: 'taskList', label: t('editor.taskList') },
  ]

  return (
    <div
      data-block-handle
      aria-hidden={info ? undefined : true}
      className="absolute z-20 flex items-center gap-0.5 transition-opacity"
      onMouseEnter={cancelHide}
      onMouseLeave={scheduleHide}
      style={{
        top,
        // 手柄落在左侧预留的装订线里（EditorPane 给内容区留了 pl-14）
        left: -46,
        opacity: info ? 1 : 0,
        pointerEvents: info ? 'auto' : 'none',
      }}
    >
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) return
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('editor.block.handle')}
            title={t('editor.block.handle')}
            className={handleClass}
            onMouseDown={(event) => event.preventDefault()}
          >
            <GripVertical className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onSelect={run((target) => void copyBlockContent(target.node))}>
            <ClipboardCopy />
            {t('editor.block.copyContent')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={run((target) => void navigator.clipboard.writeText(blockMarkdown(editor, target.node)))}
          >
            <CodeXml />
            {t('editor.block.copyMarkdown')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={run((target) => duplicateBlock(editor, target))}>
            <Copy />
            {t('editor.block.duplicate')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!info || info.pos <= 0} onSelect={run((target) => moveBlock(editor, target, 'up'))}>
            <ArrowUp />
            {t('editor.block.moveUp')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!info || info.pos + info.node.nodeSize >= editor.state.doc.content.size}
            onSelect={run((target) => moveBlock(editor, target, 'down'))}
          >
            <ArrowDown />
            {t('editor.block.moveDown')}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Pilcrow />
              {t('editor.block.turnInto')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={current}
                onValueChange={(value) =>
                  run((target) => convertBlock(editor, target, value as BlockConversionType))()
                }
              >
                {conversions.map((item) => (
                  <DropdownMenuRadioItem key={item.value} value={item.value}>
                    {item.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={run((target) => clearBlockFormatting(editor, target))}>
            <Eraser />
            {t('editor.block.clearFormatting')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onSelect={run((target) => deleteBlock(editor, target))}
          >
            <Trash2 />
            {t('common.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        aria-label={t('editor.block.addBelow')}
        title={t('editor.block.addBelow')}
        className={handleClass}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const target = activeRef.current
          if (!target) {
            toast.error(t('editor.block.pickFirst'))
            return
          }
          // 与参考实现一致：+ 号先在当前块下方开一个空段落，再唤起斜杠面板，
          // 选中命令后自然落在该块下方，而不是只插一段空段落。
          addBlockBelow(editor, target)
          requestAnimationFrame(() => {
            // 并排对照里的辅助编辑器没有注册斜杠入口，退化为只插空段落
            if (!openSlashMenu()) editor.commands.focus()
          })
        }}
      >
        <Plus className="size-3.5" />
      </button>
      {/* 透明桥接带：手柄右端到正文左边界之间不留命中空隙，鼠标移动途中不会触发隐藏 */}
      <span
        aria-hidden
        data-block-handle-bridge
        className="block h-6 shrink-0"
        style={{ width: HANDLE_BRIDGE_WIDTH_PX }}
      />
    </div>
  )
}

const handleClass =
  'flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground'
