/**
 * 图谱侧栏控制器（0.5.9）
 *
 * 图谱本体在中间大区，这里只放粒度 / 阈值 / 邻居数、节点列表与「发现 / 刷新」。
 * 页签窄时 style.css 的容器查询已会自动隐藏文字，本面板仍可用。
 */
import { AlertTriangle, Compass, Database, Loader2, RefreshCw, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useT } from '@/lib/useT'
import { useGraphStore } from '@/stores/graph'
import { useUiStore } from '@/stores/ui'

export function GraphControlPanel() {
  const t = useT()
  const snapshot = useGraphStore((state) => state.snapshot)
  const busy = useGraphStore((state) => state.busy)
  const stale = useGraphStore((state) => state.stale)
  const error = useGraphStore((state) => state.error)
  const granularity = useGraphStore((state) => state.granularity)
  const threshold = useGraphStore((state) => state.threshold)
  const topK = useGraphStore((state) => state.topK)
  const selected = useGraphStore((state) => state.selected)
  const keyword = useGraphStore((state) => state.keyword)
  const expanded = useGraphStore((state) => state.expanded)

  const setGranularity = useGraphStore((state) => state.setGranularity)
  const setThreshold = useGraphStore((state) => state.setThreshold)
  const setTopK = useGraphStore((state) => state.setTopK)
  const setKeyword = useGraphStore((state) => state.setKeyword)
  const select = useGraphStore((state) => state.select)
  const refresh = useGraphStore((state) => state.refresh)
  const expand = useGraphStore((state) => state.expand)
  const openSettings = useUiStore((state) => state.openSettings)

  const nodes = snapshot?.nodes ?? []
  const needle = keyword.trim().toLowerCase()
  const visible = needle
    ? nodes.filter((node) => `${node.label} ${node.path} ${node.excerpt}`.toLowerCase().includes(needle))
    : nodes
  const meta = snapshot?.meta

  return (
    <div className="flex h-full min-h-0 flex-col" data-graph-control="1">
      <div className="shrink-0 space-y-3 border-b border-border px-2.5 py-3">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t('graph.granularity')}</span>
            <span className="tabular-nums">{meta?.strategy === 'lexical' ? t('graph.strategy.lexical') : t('graph.strategy.vector')}</span>
          </div>
          <div className="flex rounded-md bg-muted/60 p-0.5" role="group" aria-label={t('graph.granularity')}>
            {(['source', 'chunk'] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-graph-granularity={value}
                aria-pressed={granularity === value}
                onClick={() => void setGranularity(value)}
                className={`h-6 flex-1 rounded text-[11px] transition-colors ${
                  granularity === value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {value === 'source' ? t('graph.source') : t('graph.chunk')}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            {t('graph.threshold')}
            <span className="tabular-nums">{threshold.toFixed(2)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={0.95}
            step={0.05}
            value={threshold}
            data-graph-threshold="1"
            onChange={(event) => void setThreshold(Number(event.target.value))}
            className="h-1.5 w-full cursor-pointer accent-primary"
            aria-label={t('graph.threshold')}
          />
        </label>

        <label className="block">
          <span className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            {t('graph.topK')}
            <span className="tabular-nums">{topK}</span>
          </span>
          <input
            type="range"
            min={1}
            max={12}
            step={1}
            value={topK}
            data-graph-topk="1"
            onChange={(event) => void setTopK(Number(event.target.value))}
            className="h-1.5 w-full cursor-pointer accent-primary"
            aria-label={t('graph.topK')}
          />
        </label>

        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 flex-1 px-2 text-[11px]"
            disabled={!selected || busy}
            data-graph-discover="1"
            onClick={() => {
              if (selected) void expand(selected)
            }}
          >
            <Compass className="size-3.5" />
            {t('graph.discover')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 flex-1 px-2 text-[11px]"
            disabled={busy}
            data-graph-refresh="1"
            onClick={() => void refresh(true)}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t('graph.refresh')}
          </Button>
        </div>
      </div>

      {stale ? (
        <div className="flex items-start gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300" data-graph-stale="1">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{t('graph.stale')}</span>
        </div>
      ) : null}
      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive" data-graph-error="1">
          {t('graph.error')}：{error}
        </div>
      ) : null}
      {meta?.truncated ? (
        <div className="border-b border-border px-2.5 py-2 text-[11px] text-muted-foreground" data-graph-truncated="1">
          {t('graph.truncated', { count: meta.nodeCount })}
        </div>
      ) : null}

      <div className="shrink-0 px-2.5 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={t('graph.search')}
            data-graph-search="1"
            className="h-8 w-full rounded-md border border-border/70 bg-muted/30 pr-7 pl-7 text-xs outline-none transition-colors focus:border-ring/50 focus:bg-background"
          />
          {keyword ? (
            <button
              type="button"
              onClick={() => setKeyword('')}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted"
              aria-label={t('common.clear')}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" data-graph-node-list="1">
        {visible.length === 0 ? (
          <div className="px-1.5 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            <Database className="mx-auto mb-2 size-5 opacity-60" />
            <p>{t('graph.empty')}</p>
            <p className="mt-1">{t('graph.emptyHint')}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 text-[11px]"
              onClick={() => openSettings('rag')}
            >
              {t('graph.openSettings')}
            </Button>
          </div>
        ) : (
          visible.map((node) => (
            <button
              key={node.id}
              type="button"
              data-graph-list-node={node.id}
              aria-current={selected === node.id ? 'true' : undefined}
              onClick={() => select(node.id)}
              onDoubleClick={() => void expand(node.id)}
              className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                selected === node.id
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  node.isolated ? 'bg-muted-foreground' : node.kind === 'chunk' ? 'bg-teal-500' : 'bg-blue-500'
                }`}
              />
              <span className="min-w-0 flex-1 truncate">{node.label}</span>
              {expanded.includes(node.id) ? <Compass className="size-3 shrink-0 opacity-60" /> : null}
              <span className="shrink-0 tabular-nums opacity-60">{node.degree}</span>
            </button>
          ))
        )}
      </div>

      {meta ? (
        <div className="shrink-0 border-t border-border px-2.5 py-2 text-[11px] text-muted-foreground" data-graph-meta="1">
          <p>{t('graph.meta', { sources: meta.sources, chunks: meta.chunks, dimension: meta.dimension })}</p>
          <p className="mt-0.5">{t('graph.edgeCount', { count: meta.edgeCount })}</p>
        </div>
      ) : null}
    </div>
  )
}
