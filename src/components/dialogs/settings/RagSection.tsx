/**
 * 设置 → 知识库（RAG）
 *
 * 版式沿用 Parts 的「分组 + 卡片」结构：统计、索引参数、开关、索引操作、
 * 快照、检索诊断。后端 rpc 与 store 字段由主工程按约定补齐，本文件只负责调用。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Database,
  Download,
  Loader2,
  RefreshCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'
import * as rpc from '@/lib/rpc'

import { SettingPage, SettingSection, SettingItem, Segmented } from './Parts'

/** 与后端约定的索引统计结构（接口由主工程实现） */
interface RagStatus {
  configured: boolean
  embeddingModel: string
  sources: number
  chunks: number
  dimension: number
  lastIndexedAt: number
}

/** 与 store 约定的知识库设置结构 */
interface RagValues {
  chunkSize: number
  chunkOverlap: number
  topK: number
  threshold: number
  autoVector: boolean
  autoInject: boolean
}

/** 检索命中片段 */
interface RagHit {
  path: string
  title: string
  content: string
  score: number
}

type ActionKey = 'rebuild' | 'clear' | 'upload' | 'download' | 'diagnose'
type HitLimit = '3' | '5' | '10'
type TFn = ReturnType<typeof useT>

/** 把未知异常转成可展示文案，避免 toast 二次抛错 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 数字输入解析：空值/非法值回退当前值，越界钳制；小数保留两位 */
function num(raw: string, min: number, max: number, current: number, round: boolean): number {
  if (raw.trim() === '') return current
  const n = Number(raw)
  if (!Number.isFinite(n)) return current
  const v = Math.min(max, Math.max(min, n))
  return round ? Math.round(v) : Math.round(v * 100) / 100
}

/** 统一维护状态、loading/busy 与错误提示，供各分组复用 */
function useRagController() {
  const t = useT()
  const rag = useSettingsStore((s) => s.rag)
  const patchRag = useSettingsStore((s) => s.patchRag)
  /** 对话面板的「引用知识库」默认值读这个旧开关，两个开关在本页一起展示 */
  const knowledgeEnabled = useSettingsStore((s) => s.knowledgeEnabled)
  const patchSettings = useSettingsStore((s) => s.patch)
  const [status, setStatus] = useState<RagStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<RagHit[]>([])
  const [searched, setSearched] = useState(false)
  const [hitLimit, setHitLimit] = useState<HitLimit>('5')

  /** 拉取索引统计，失败只提示、不阻断页面 */
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await rpc.kbStatus())
    } catch (err) {
      toast.error(t('rag.index.failed'), { description: errText(err) })
    } finally {
      setLoading(false)
    }
  }, [t])
  useEffect(() => { void refresh() }, [refresh])

  /** 包装异步动作：统一 busy 态与错误提示 */
  const run = async (key: ActionKey, task: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    try {
      await task()
    } catch (err) {
      toast.error(t('rag.index.failed'), { description: errText(err) })
    } finally {
      setBusy(null)
    }
  }

  return {
    t, rag, patchRag, knowledgeEnabled, patchSettings,
    status, loading, busy, query, setQuery, hits, setHits,
    searched, setSearched, hitLimit, setHitLimit, refresh, run,
  }
}

type RagModel = ReturnType<typeof useRagController>

/** 由统一模型派生出五个界面动作，避免主组件过长 */
function buildActions(m: RagModel) {
  const { t, rag, run, refresh, query, setHits, setSearched } = m

  /** 全量重建：按当前索引参数执行，成功后刷新统计 */
  const rebuild = () => run('rebuild', async () => {
    const res = await rpc.kbReindexAll({
      chunkSize: rag.chunkSize,
      chunkOverlap: rag.chunkOverlap,
      topK: rag.topK,
      threshold: rag.threshold,
    })
    toast.success(t('rag.index.rebuilt', { indexed: res.indexed, chunks: res.chunks }))
    if (res.failed.length) {
      toast.error(t('rag.index.failed'), { description: res.failed.join('; ') })
    }
    await refresh()
  })

  /** 清空索引：必须先用浏览器原生确认框二次确认 */
  const clear = () => {
    if (!window.confirm(t('rag.index.clearConfirm'))) return
    void run('clear', async () => {
      const res = await rpc.kbClearIndex()
      toast.success(t('rag.index.cleared', { cleared: res.cleared }))
      await refresh()
    })
  }

  /** 上传快照：导出后尽力推送同步，同步失败只提示、不算整体失败 */
  const upload = () => run('upload', async () => {
    await rpc.kbExportSnapshot()
    try {
      await rpc.syncPush()
    } catch (err) {
      toast.warning(errText(err))
    }
    toast.success(t('rag.snapshot.uploaded'))
  })

  /** 下载快照：导入后刷新统计 */
  const download = () => run('download', async () => {
    await rpc.kbImportSnapshot({})
    toast.success(t('rag.snapshot.downloaded'))
    await refresh()
  })

  /** 检索诊断：空查询视为未检索 */
  const diagnose = () => run('diagnose', async () => {
    const q = query.trim()
    if (!q) {
      setHits([])
      setSearched(false)
      return
    }
    const res = await rpc.kbSearch({ query: q, topK: rag.topK, threshold: rag.threshold })
    setHits(res.items)
    setSearched(true)
  })

  return { rebuild, clear, upload, download, diagnose }
}

/** 顶部统计卡片：模型、来源、分块、维度与最近索引时间 */
function StatusCard({ t, status, loading, onRefresh }: {
  t: TFn
  status: RagStatus | null
  loading: boolean
  onRefresh: () => void
}) {
  const cells = [
    {
      label: t('rag.status.model'),
      value: status?.configured ? status.embeddingModel : t('rag.status.notConfigured'),
    },
    { label: t('rag.status.sources'), value: status ? String(status.sources) : '—' },
    { label: t('rag.status.chunks'), value: status ? String(status.chunks) : '—' },
    { label: t('rag.status.dimension'), value: status ? String(status.dimension) : '—' },
    {
      label: t('rag.status.last'),
      value: !status
        ? '—'
        : status.lastIndexedAt
          ? new Date(status.lastIndexedAt).toLocaleString()
          : t('rag.status.never'),
    },
  ]
  return (
    <SettingSection
      title={t('rag.status.title')}
      desc={t('rag.status.desc')}
      action={
        <Button size="icon-xs" variant="ghost" aria-label={t('rag.status.title')}
          disabled={loading} onClick={onRefresh}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
        </Button>
      }
    >
      <div className="rounded-lg border border-border p-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {cells.map((cell) => (
            <div key={cell.label} className="min-w-0">
              <div className="text-[11px] text-muted-foreground">{cell.label}</div>
              <div className="mt-0.5 truncate text-[13px] font-medium" title={cell.value}>
                {cell.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SettingSection>
  )
}

/** 单个数字参数：实时写回 store，自动钳制到合法范围 */
function NumField({ id, label, value, min, max, step, onChange }: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (next: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={min} max={max} step={step} value={value}
        onChange={(event) => onChange(num(event.target.value, min, max, value, step >= 1))} />
    </div>
  )
}

/** 索引参数：分块大小、重叠、召回数与阈值 */
function ParamsGroup({ t, rag, patchRag }: {
  t: TFn
  rag: RagValues
  patchRag: (next: Partial<RagValues>) => void
}) {
  return (
    <SettingSection title={t('rag.params.title')} desc={t('rag.params.desc')}>
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 sm:grid-cols-4">
        <NumField id="rag-chunk-size" label={t('rag.params.chunkSize')} value={rag.chunkSize}
          min={100} max={5000} step={50} onChange={(v) => patchRag({ chunkSize: v })} />
        <NumField id="rag-chunk-overlap" label={t('rag.params.chunkOverlap')} value={rag.chunkOverlap}
          min={0} max={Math.min(500, rag.chunkSize - 50)} step={10}
          onChange={(v) => patchRag({ chunkOverlap: v })} />
        <NumField id="rag-top-k" label={t('rag.params.topK')} value={rag.topK}
          min={1} max={10} step={1} onChange={(v) => patchRag({ topK: v })} />
        <NumField id="rag-threshold" label={t('rag.params.threshold')} value={rag.threshold}
          min={0} max={1} step={0.05} onChange={(v) => patchRag({ threshold: v })} />
      </div>
    </SettingSection>
  )
}

/** 总开关、自动更新与对话注入开关 */
function SwitchGroup({ t, rag, patchRag, knowledgeEnabled, patchSettings }: {
  t: TFn
  rag: RagValues
  patchRag: (next: Partial<RagValues>) => void
  knowledgeEnabled: boolean
  patchSettings: (next: { knowledgeEnabled: boolean }) => void
}) {
  return (
    <SettingSection>
      <SettingItem title={t('rag.enable.title')} desc={t('rag.enable.desc')}>
        <Switch aria-label={t('rag.enable.title')} checked={knowledgeEnabled}
          onCheckedChange={(value) => patchSettings({ knowledgeEnabled: value })} />
      </SettingItem>
      <SettingItem title={t('rag.auto.title')} desc={t('rag.auto.desc')}>
        <Switch aria-label={t('rag.auto.title')} checked={rag.autoVector}
          onCheckedChange={(value) => patchRag({ autoVector: value })} />
      </SettingItem>
      <SettingItem title={t('rag.inject.title')} desc={t('rag.inject.desc')}>
        <Switch aria-label={t('rag.inject.title')} checked={rag.autoInject}
          onCheckedChange={(value) => patchRag({ autoInject: value })} />
      </SettingItem>
    </SettingSection>
  )
}

/** 索引操作：全量重建与清空（清空需二次确认） */
function IndexActions({ t, busy, onRebuild, onClear }: {
  t: TFn
  busy: ActionKey | null
  onRebuild: () => void
  onClear: () => void
}) {
  return (
    <SettingSection>
      <div className="flex flex-wrap gap-2 rounded-lg border border-border p-3">
        <Button size="sm" variant="outline" data-rag-action="rebuild"
          disabled={busy !== null} onClick={onRebuild}>
          {busy === 'rebuild' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
          {t('rag.index.rebuild')}
        </Button>
        <Button size="sm" variant="destructive" data-rag-action="clear"
          disabled={busy !== null} onClick={onClear}>
          {busy === 'clear' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          {t('rag.index.clear')}
        </Button>
      </div>
    </SettingSection>
  )
}

/** 知识库快照：上传（导出）与下载（导入） */
function SnapshotGroup({ t, busy, onUpload, onDownload }: {
  t: TFn
  busy: ActionKey | null
  onUpload: () => void
  onDownload: () => void
}) {
  return (
    <SettingSection title={t('rag.snapshot.title')} desc={t('rag.snapshot.desc')}>
      <div className="flex flex-wrap gap-2 rounded-lg border border-border p-3">
        <Button size="sm" variant="outline" data-rag-action="upload"
          disabled={busy !== null} onClick={onUpload}>
          {busy === 'upload' ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          {t('rag.snapshot.upload')}
        </Button>
        <Button size="sm" variant="outline" data-rag-action="download"
          disabled={busy !== null} onClick={onDownload}>
          {busy === 'download' ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          {t('rag.snapshot.download')}
        </Button>
      </div>
    </SettingSection>
  )
}

/** 检索诊断：输入查询并展示前若干条命中 */
function DiagnosticGroup({ t, busy, query, setQuery, hits, searched, hitLimit, setHitLimit, onRun }: {
  t: TFn
  busy: ActionKey | null
  query: string
  setQuery: (next: string) => void
  hits: RagHit[]
  searched: boolean
  hitLimit: HitLimit
  setHitLimit: (next: HitLimit) => void
  onRun: () => void
}) {
  return (
    <SettingSection title={t('rag.diagnostic.title')} desc={t('rag.diagnostic.desc')}>
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="min-w-40 flex-1" placeholder={t('rag.diagnostic.placeholder')}
            value={query} onChange={(event) => setQuery(event.target.value)} />
          <Segmented<HitLimit> value={hitLimit} label={t('rag.diagnostic.title')}
            options={[
              { value: '3', label: '3' },
              { value: '5', label: '5' },
              { value: '10', label: '10' },
            ]}
            onChange={setHitLimit} />
          <Button size="sm" data-rag-action="diagnose" disabled={busy !== null} onClick={onRun}>
            {busy === 'diagnose' ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
            {t('rag.diagnostic.run')}
          </Button>
        </div>
        {searched && hits.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t('rag.diagnostic.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {hits.slice(0, Number(hitLimit)).map((hit, index) => (
              <li key={`${hit.path}-${index}`} className="rounded-md bg-muted/50 p-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium" title={hit.path}>{hit.title || hit.path}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{hit.score.toFixed(3)}</span>
                </div>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  {hit.content.length > 120 ? `${hit.content.slice(0, 120)}…` : hit.content}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingSection>
  )
}

/** 设置 → 知识库（RAG）页面 */
export function RagSection() {
  const m = useRagController()
  const a = buildActions(m)
  return (
    <div data-settings-panel="rag">
      <SettingPage title={m.t('rag.title')} desc={m.t('rag.desc')}>
        <StatusCard t={m.t} status={m.status} loading={m.loading} onRefresh={m.refresh} />
        <ParamsGroup t={m.t} rag={m.rag} patchRag={m.patchRag} />
        <SwitchGroup t={m.t} rag={m.rag} patchRag={m.patchRag}
          knowledgeEnabled={m.knowledgeEnabled} patchSettings={m.patchSettings} />
        <IndexActions t={m.t} busy={m.busy} onRebuild={a.rebuild} onClear={a.clear} />
        <SnapshotGroup t={m.t} busy={m.busy} onUpload={a.upload} onDownload={a.download} />
        <DiagnosticGroup t={m.t} busy={m.busy} query={m.query} setQuery={m.setQuery}
          hits={m.hits} searched={m.searched} hitLimit={m.hitLimit} setHitLimit={m.setHitLimit}
          onRun={a.diagnose} />
      </SettingPage>
    </div>
  )
}
