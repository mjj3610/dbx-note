import { useMemo } from 'react'

import { EmptyState } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { parseOutline, useNotesStore } from '@/stores/notes'

/**
 * 大纲：解析当前笔记的标题层级，点击联动编辑器滚动
 *
 * 注意：不要在 selector 里调用会返回新数组的方法（zustand v5 会判定快照变化 → 死循环），
 * 因此这里取原始 content，再用 useMemo 计算。
 */
export function OutlinePanel() {
  const t = useT()
  const activePath = useNotesStore((state) => state.activePath)
  const content = useNotesStore((state) => state.content)
  const outline = useMemo(() => parseOutline(content), [content])

  if (!activePath) {
    return <EmptyState title={t('editor.noFile')} description={t('editor.noFileHint')} />
  }

  if (outline.length === 0) {
    return <EmptyState title={t('outline.title')} description={t('outline.empty')} />
  }

  return (
    <div className="h-full overflow-y-auto px-2 py-2">
      {outline.map((item) => (
        <button
          key={`${item.line}-${item.text}`}
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('dbx-note:scroll-to-heading', { detail: item.text }))
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
