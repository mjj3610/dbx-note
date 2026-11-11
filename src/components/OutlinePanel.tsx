import { EmptyState } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useOutline } from '@/lib/outlineStore'
import { useNotesStore } from '@/stores/notes'

/**
 * 大纲：消费编辑器的标题索引（id + pos），点击按 id 定位
 *
 * 与参考项目一致，标题来自 ProseMirror doc 而不是 Markdown 文本：
 * 打开面板无需重新解析全文，编辑时只在标题内容变化才重渲染；
 * 点击传稳定的 id，任意层级、重复文本、带行内语法的标题都能命中。
 */
export function OutlinePanel() {
  const t = useT()
  const activePath = useNotesStore((state) => state.activePath)
  const { headings, source } = useOutline()

  if (!activePath) {
    return <EmptyState title={t('editor.noFile')} description={t('editor.noFileHint')} />
  }

  if (headings.length === 0) {
    return <EmptyState title={t('outline.title')} description={t('outline.empty')} />
  }

  return (
    <div
      className="h-full overflow-y-auto px-2 py-2"
      data-outline-panel="1"
      data-outline-source={source}
    >
      {headings.map((item) => (
        <button
          key={item.id}
          type="button"
          data-outline-id={item.id}
          data-outline-level={item.level}
          onClick={() => {
            window.dispatchEvent(new CustomEvent('dbx-note:scroll-to-heading', { detail: item.id }))
          }}
          className={cn(
            'mb-0.5 block w-full truncate rounded-md py-1 pr-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            item.level === 1 && 'font-medium text-foreground',
            item.level === 2 && 'font-medium',
          )}
          style={{ paddingLeft: 6 + (item.level - 1) * 12 }}
          title={item.text}
        >
          {item.text}
        </button>
      ))}
    </div>
  )
}
