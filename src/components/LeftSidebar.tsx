import { useEffect, useMemo, useState } from 'react'
import { FileText, FolderPlus, Highlighter, ListTree, Palette, Plus, RefreshCw, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { applyFileView } from '@/lib/tree'
import { cn, debounce } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { currentFolder, useNotesStore } from '@/stores/notes'
import { useRecordsStore } from '@/stores/records'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore, type SidebarTab } from '@/stores/ui'
import { FileMoreMenu } from './FileMoreMenu'
import { FileTree } from './FileTree'
import { RecordPanel } from './RecordPanel'
import { CanvasPanel } from './canvas/CanvasPanel'
import { OutlinePanel } from './OutlinePanel'

const TABS: Array<{ value: SidebarTab; icon: typeof FileText; labelKey: string }> = [
  { value: 'files', icon: FileText, labelKey: 'nav.files' },
  { value: 'records', icon: Highlighter, labelKey: 'nav.records' },
  { value: 'canvases', icon: Palette, labelKey: 'nav.canvases' },
  { value: 'outline', icon: ListTree, labelKey: 'nav.outline' },
]

/**
 * 左侧栏：页签（文件 / 记录 / 大纲）+ 搜索 + 对应面板
 */
export function LeftSidebar() {
  const t = useT()
  const tab = useUiStore((state) => state.tab)
  const setTab = useUiStore((state) => state.setTab)
  const startNewItem = useUiStore((state) => state.startNewItem)

  const [keyword, setKeyword] = useState('')
  const tree = useNotesStore((state) => state.tree)
  const loadTree = useNotesStore((state) => state.loadTree)
  const setRecordFilter = useRecordsStore((state) => state.setFilter)
  const loadRecords = useRecordsStore((state) => state.load)
  const fileView = useSettingsStore((state) => state.fileView)

  // 记录搜索走后端，输入防抖 260ms
  const pushRecordQuery = useMemo(
    () => debounce((value: string) => setRecordFilter({ query: value }), 260),
    [setRecordFilter],
  )
  useEffect(() => {
    if (tab === 'records') pushRecordQuery(keyword)
  }, [keyword, pushRecordQuery, tab])

  // 先按搜索词过滤，再套用「文件视图」偏好（排序 / 隐藏资源文件夹 / 隐藏仅云端节点）
  const filteredTree = useMemo(() => {
    const searched = keyword.trim() ? filterTree(tree, keyword.trim().toLowerCase()) : tree
    return applyFileView(searched, fileView)
  }, [tree, keyword, fileView])

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
        {/* 侧栏被拖窄或分屏出现时，页签改为纯图标（容器查询见 style.css） */}
        <div className="sidebar-tabs min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/60 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((item) => {
            const Icon = item.icon
            const active = tab === item.value
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setTab(item.value)}
                // 窄侧栏会隐藏文字标签，这里保证无障碍名称与可测试性不丢
                aria-label={t(item.labelKey)}
                aria-current={active ? 'page' : undefined}
                title={t(item.labelKey)}
                className={cn(
                  'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="tab-label">{t(item.labelKey)}</span>
              </button>
            )
          })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {tab === 'files' ? (
            <>
              <Hint label={`${t('sidebar.newNote')} (Ctrl+N)`}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('sidebar.newNote')}
                  onClick={() => startNewItem('file', currentFolder())}
                >
                  <Plus className="size-4" />
                </Button>
              </Hint>
              <Hint label={t('sidebar.newFolder')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('sidebar.newFolder')}
                  onClick={() => startNewItem('folder', currentFolder())}
                >
                  <FolderPlus className="size-4" />
                </Button>
              </Hint>
            </>
          ) : null}
          {tab === 'records' ? (
            <Hint label={t('common.refresh')}>
              <Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={() => void loadRecords()}>
                <RefreshCw className="size-4" />
              </Button>
            </Hint>
          ) : null}
          {tab === 'files' ? (
            <>
              <Hint label={t('common.refresh')}>
                <Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={() => void loadTree()}>
                  <RefreshCw className="size-4" />
                </Button>
              </Hint>
              <FileMoreMenu />
            </>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-2 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={t('sidebar.searchPlaceholder')}
            className="h-8 w-full rounded-md border border-border/70 bg-muted/30 pr-7 pl-7 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring/50 focus:bg-background"
          />
          {keyword ? (
            <button
              type="button"
              onClick={() => setKeyword('')}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'files' ? <FileTree nodes={filteredTree} keyword={keyword.trim().toLowerCase()} /> : null}
        {tab === 'records' ? <RecordPanel /> : null}
        {tab === 'canvases' ? <CanvasPanel /> : null}
        {tab === 'outline' ? <OutlinePanel /> : null}
      </div>
    </div>
  )
}

/** 按名称过滤文件树（保留命中节点的祖先链） */
function filterTree(nodes: ReturnType<typeof useNotesStore.getState>['tree'], keyword: string) {
  const result: typeof nodes = []
  for (const node of nodes) {
    if (node.kind === 'folder') {
      const children = filterTree(node.children ?? [], keyword)
      if (children.length > 0) result.push({ ...node, children })
      continue
    }
    if (node.name.toLowerCase().includes(keyword)) result.push(node)
  }
  return result
}
