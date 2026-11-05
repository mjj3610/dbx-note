import { FileText, MessageSquareText, PenLine } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useUiStore, type MobilePane } from '@/stores/ui'

const ITEMS: Array<{ value: MobilePane; icon: typeof FileText; labelKey: string }> = [
  { value: 'sidebar', icon: FileText, labelKey: 'nav.files' },
  { value: 'editor', icon: PenLine, labelKey: 'mobile.editor' },
  { value: 'chat', icon: MessageSquareText, labelKey: 'chat.title' },
]

/**
 * 窄屏底部导航：三栏收成单栏，靠它切换
 */
export function MobileNav() {
  const t = useT()
  const pane = useUiStore((state) => state.mobilePane)
  const setPane = useUiStore((state) => state.setMobilePane)

  return (
    <nav className="flex h-12 shrink-0 items-stretch border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      {ITEMS.map((item) => {
        const Icon = item.icon
        const active = pane === item.value
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => setPane(item.value)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors',
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="size-4" />
            {t(item.labelKey)}
          </button>
        )
      })}
    </nav>
  )
}
