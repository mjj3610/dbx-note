/**
 * 知识块详情抽屉（0.5.9）
 *
 * 图谱节点 → 知识块正文 → 原笔记的联动落点。节点已由后端带上摘要正文，
 * 所以这里不再发检索 RPC；「打开原笔记」派发 dbx-note:reveal-chunk，
 * 由编辑器在正文里定位到该分块。
 */
import { useEffect } from 'react'
import { Compass, ExternalLink, FileText, Layers3 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import type { GraphEdge, GraphNode } from '@/lib/rpc'
import { useT } from '@/lib/useT'
import { REVEAL_CHUNK_EVENT, useGraphStore } from '@/stores/graph'
import { useNotesStore } from '@/stores/notes'
import { useUiStore } from '@/stores/ui'

interface ChunkDetailProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const EDGE_LABEL: Record<GraphEdge['kind'], string> = {
  semantic: 'graph.semantic',
  lexical: 'graph.lexical',
  adjacent: 'graph.adjacent',
}

/** 摘要里去掉 Markdown 标记后取前若干字，作为原文定位用的针 */
function needleOf(excerpt: string): string {
  return excerpt.replace(/[\s#*`>_\[\]()!~|]/g, '').slice(0, 48)
}

export function ChunkDetail({ nodes, edges }: ChunkDetailProps) {
  const t = useT()
  const selected = useGraphStore((state) => state.selected)
  const select = useGraphStore((state) => state.select)
  const expand = useGraphStore((state) => state.expand)
  const busy = useGraphStore((state) => state.busy)
  const setTab = useUiStore((state) => state.setTab)
  const node = nodes.find((item) => item.id === selected) ?? null

  // 切换粒度 / 刷新后旧选中 id 可能不存在，清掉避免详情区留空壳
  useEffect(() => {
    if (selected && !node) select(null)
  }, [selected, node, select])

  const related = node
    ? edges
        .filter((edge) => edge.source === node.id || edge.target === node.id)
        .map((edge) => {
          const otherId = edge.source === node.id ? edge.target : edge.source
          return { edge, other: nodes.find((item) => item.id === otherId) }
        })
        .filter((item): item is { edge: GraphEdge; other: GraphNode } => Boolean(item.other))
        .sort((a, b) => b.edge.score - a.edge.score)
        .slice(0, 12)
    : []

  const openNote = async () => {
    if (!node?.path) return
    const excerpt = node.excerpt
    setTab('files')
    try {
      await useNotesStore.getState().open(node.path)
      // EditorPane 全程 hidden 保活，但 MarkdownEditor 按 activePath 重建，
      // 等它注册完 editorBus 再派发定位事件；EditorPane 内部还有重试兜底。
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(REVEAL_CHUNK_EVENT, { detail: needleOf(excerpt) }))
      }, 260)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <aside
      className="flex h-full w-[268px] shrink-0 flex-col border-l border-border bg-background"
      data-graph-detail="1"
      aria-label={t('graph.detail')}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-medium">
        <Layers3 className="size-3.5 text-muted-foreground" />
        {t('graph.detail')}
      </div>

      {!node ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-[11px] text-muted-foreground">
          <FileText className="size-5 opacity-60" />
          <p>{t('graph.selectHint')}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <h3 className="text-sm leading-snug font-medium break-words" data-graph-detail-title="1">
            {node.title || node.label}
          </h3>
          <p className="mt-1 truncate text-[11px] text-muted-foreground" title={node.path}>
            {node.path || '—'}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">
              {t('graph.chunkIndex', { index: (node.chunkId ?? 0) + 1 })}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5">{node.chunkCount} chunks</span>
            {node.isolated ? (
              <span className="rounded bg-muted px-1.5 py-0.5">{t('graph.isolated')}</span>
            ) : null}
          </div>

          <div className="mt-3 rounded-md border border-border/70 bg-muted/30 p-2.5 text-[11px] leading-relaxed break-words whitespace-pre-wrap">
            {node.excerpt || '—'}
          </div>

          <div className="mt-3 flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-1 px-2 text-[11px]"
              data-graph-open-note="1"
              onClick={() => void openNote()}
            >
              <ExternalLink className="size-3.5" />
              {t('graph.openNote')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-1 px-2 text-[11px]"
              disabled={busy}
              data-graph-detail-discover="1"
              onClick={() => void expand(node.id)}
            >
              <Compass className="size-3.5" />
              {t('graph.discover')}
            </Button>
          </div>

          <div className="mt-4 mb-1.5 text-[11px] text-muted-foreground">{t('graph.related')}</div>
          {related.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t('graph.isolated')}</p>
          ) : (
            <div className="space-y-1">
              {related.map(({ edge, other }) => (
                <button
                  key={`${edge.source}|${edge.target}`}
                  type="button"
                  data-graph-related={other.id}
                  onClick={() => select(other.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/60"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-blue-500" />
                  <span className="min-w-0 flex-1 truncate">{other.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {edge.score.toFixed(2)}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t(EDGE_LABEL[edge.kind])}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
