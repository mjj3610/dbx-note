import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CHART_TYPES, chartToTable, parseChartTable, type CanvasChartSpec } from '@/lib/canvasChart'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'

/**
 * 图表编辑面板
 *
 * 数据用「表格文本」编辑：从 Excel / 飞书表格 / Markdown 表格里复制一段粘进来即可，
 * 比一行行填输入框快；类型与标题是即时生效的，数据点「应用」后重绘。
 */
export function ChartPanel({
  spec,
  onChange,
  onClose,
}: {
  spec: CanvasChartSpec
  onChange: (next: CanvasChartSpec) => void
  onClose: () => void
}) {
  const t = useT()
  const [text, setText] = useState(() => chartToTable(spec))
  const [error, setError] = useState('')

  // 换了一张图（点了别的图表节点）时把文本同步过去
  useEffect(() => {
    setText(chartToTable(spec))
    setError('')
  }, [spec])

  const apply = () => {
    const parsed = parseChartTable(text)
    if (!parsed) {
      setError(t('canvas.chart.parseError'))
      return
    }
    setError('')
    onChange({ ...parsed, type: spec.type, title: spec.title })
  }

  return (
    <div
      data-canvas-chart-panel
      className="absolute top-3 right-3 z-20 flex w-80 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
    >
      <div className="flex h-10 shrink-0 items-center justify-between pl-3 pr-1.5">
        <span className="text-[13px] font-medium">{t('canvas.chart.title')}</span>
        <Button variant="ghost" size="icon-sm" aria-label={t('common.close')} onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-2.5 overflow-y-auto p-3 pt-0">
        <div className="grid grid-cols-3 gap-1">
          {CHART_TYPES.map((item) => (
            <button
              key={item.type}
              type="button"
              data-chart-type={item.type}
              aria-pressed={spec.type === item.type}
              onClick={() => onChange({ ...spec, type: item.type })}
              className={cn(
                'h-7 rounded-lg border text-[11px] transition-colors',
                spec.type === item.type
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">{t('canvas.chart.chartTitle')}</span>
          <input
            value={spec.title}
            aria-label={t('canvas.chart.chartTitle')}
            onChange={(event) => onChange({ ...spec, title: event.target.value })}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-[12px] outline-none focus:border-ring/60"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">{t('canvas.chart.data')}</span>
          <textarea
            value={text}
            aria-label={t('canvas.chart.data')}
            onChange={(event) => setText(event.target.value)}
            onBlur={apply}
            rows={7}
            spellCheck={false}
            className="w-full resize-none rounded-lg border border-input bg-transparent p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-ring/60"
          />
        </label>

        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">{t('canvas.chart.dataHint')}</span>
          <Button size="sm" variant="outline" onClick={apply}>
            {t('canvas.chart.apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}
