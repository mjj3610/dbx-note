/**
 * 中间大区知识图谱工作区（0.5.9）
 *
 * App.tsx 用 hidden 保活编辑器，把本组件覆盖在同一 Panel 内；因此切进 / 切出
 * 图谱不会卸载 Tiptap / CodeMirror / CanvasEditor，undo 栈、未保存内容与大纲
 * 索引都保持原样。图谱数据只在页签激活时懒加载，不与保存 / 同步抢 RPC。
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Focus, Loader2, Network, RefreshCw, Settings2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useT } from '@/lib/useT'
import { useGraphStore } from '@/stores/graph'
import { useUiStore } from '@/stores/ui'
import { ChunkDetail } from './ChunkDetail'
import { GraphCanvas } from './GraphCanvas'

export function GraphWorkspace() {
  const t = useT()
  const snapshot = useGraphStore((state) => state.snapshot)
  const busy = useGraphStore((state) => state.busy)
  const stale = useGraphStore((state) => state.stale)
  const error = useGraphStore((state) => state.error)
  const selected = useGraphStore((state) => state.selected)
  const keyword = useGraphStore((state) => state.keyword)
  const activate = useGraphStore((state) => state.activate)
  const refresh = useGraphStore((state) => state.refresh)
  const checkStale = useGraphStore((state) => state.checkStale)
  const markStale = useGraphStore((state) => state.markStale)
  const select = useGraphStore((state) => state.select)
  const expand = useGraphStore((state) => state.expand)
  const openSettings = useUiStore((state) => state.openSettings)
  const [fitToken, setFitToken] = useState(0)

  useEffect(() => {
    void activate()
  }, [activate])

  // 知识库重新计算后标脏；窗口回前台再核一次水印（与远端清单回前台刷新同款语义）
  useEffect(() => {
    const onReindexed = () => markStale()
    const onFocus = () => void checkStale()
    window.addEventListener('dbx:kb-reindexed', onReindexed)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('dbx:kb-reindexed', onReindexed)
      window.removeEventListener('focus', onFocus)
    }
  }, [markStale, checkStale])

  const nodes = snapshot?.nodes ?? []
  const edges = snapshot?.edges ?? []
  const meta = snapshot?.meta

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-graph-workspace="1">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Network className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('graph.title')}</span>
        {meta ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" data-graph-strategy={meta.strategy}>
            {meta.strategy === 'vector' ? t('graph.strategy.vector') : t('graph.strategy.lexical')}
          </span>
        ) : null}
        {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" data-graph-busy="1" /> : null}
        <span className="ml-1 hidden truncate text-[11px] text-muted-foreground sm:inline">
          {meta
            ? t('graph.meta', { sources: meta.sources, chunks: meta.chunks, dimension: meta.dimension })
            : ''}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('graph.fit')}
            title={t('graph.fit')}
            data-graph-fit="1"
            onClick={() => setFitToken((value) => value + 1)}
          >
            <Focus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('graph.refresh')}
            title={t('graph.refresh')}
            data-graph-workspace-refresh="1"
            disabled={busy}
            onClick={() => void refresh(true)}
          >
            <RefreshCw className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('graph.openSettings')}
            title={t('graph.openSettings')}
            onClick={() => openSettings('rag')}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {nodes.length > 0 ? (
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              selected={selected}
              keyword={keyword}
              fitToken={fitToken}
              onSelect={select}
              onDiscover={(id) => void expand(id)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-graph-empty="1">
              <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Network className="size-5" />
              </div>
              <div>
                <p className="text-sm font-medium">
                  {busy ? t('graph.loading') : t('graph.empty')}
                </p>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  {t('graph.emptyHint')}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => openSettings('rag')}>
                {t('graph.openSettings')}
              </Button>
            </div>
          )}
        </div>
        <ChunkDetail nodes={nodes} edges={edges} />
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted-foreground">
        {error ? (
          <span className="text-destructive" data-graph-status-error="1">{t('graph.error')}：{error}</span>
        ) : null}
        {stale && !error ? (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300" data-graph-status-stale="1">
            <AlertTriangle className="size-3" />
            {t('graph.stale')}
          </span>
        ) : null}
        {meta ? (
          <span data-graph-status-meta="1">
            {t('graph.edgeCount', { count: meta.edgeCount })}
            {meta.truncated ? ` · ${t('graph.truncated', { count: meta.nodeCount })}` : ''}
          </span>
        ) : null}
        <span className="ml-auto">{t('graph.selectHint')}</span>
      </div>
    </div>
  )
}
