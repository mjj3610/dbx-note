/**
 * 画布数据图表
 *
 * 一份 spec 描述整张图：类型 + 类目列 + 若干系列 + 数据行。
 * 数据用「表格文本」编辑（粘贴 Excel / CSV / TSV 即可），比一个个填输入框快得多，
 * 也方便把一段 Markdown 表格直接贴进来。
 */

export type CanvasChartType = 'bar' | 'line' | 'area' | 'pie' | 'radar' | 'radial'

export interface CanvasChartDatum {
  label: string
  values: number[]
}

export interface CanvasChartSpec {
  type: CanvasChartType
  title: string
  categoryLabel: string
  series: { name: string }[]
  data: CanvasChartDatum[]
}

export const CHART_TYPES: { type: CanvasChartType; labelKey: string }[] = [
  { type: 'bar', labelKey: 'canvas.chart.bar' },
  { type: 'line', labelKey: 'canvas.chart.line' },
  { type: 'area', labelKey: 'canvas.chart.area' },
  { type: 'pie', labelKey: 'canvas.chart.pie' },
  { type: 'radar', labelKey: 'canvas.chart.radar' },
  { type: 'radial', labelKey: 'canvas.chart.radial' },
]

/** 系列配色：与编辑器高亮色板同一套色相，深浅色主题下都能看清 */
export const CHART_PALETTE = [
  '#60a5fa',
  '#f472b6',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#22d3ee',
  '#fb7185',
  '#facc15',
]

export function seriesColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]
}

export function defaultChartSpec(): CanvasChartSpec {
  return {
    type: 'bar',
    title: '月度数据',
    categoryLabel: '月份',
    series: [{ name: '收入' }, { name: '支出' }],
    data: [
      { label: '1 月', values: [120, 80] },
      { label: '2 月', values: [160, 96] },
      { label: '3 月', values: [140, 110] },
      { label: '4 月', values: [210, 128] },
    ],
  }
}

function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === delimiter && !quoted) {
      cells.push(value.trim())
      value = ''
    } else {
      value += character
    }
  }
  cells.push(value.trim())
  return cells
}

function detectDelimiter(line: string): string {
  if (line.includes('\t')) return '\t'
  if (line.includes(';') && !line.includes(',')) return ';'
  return ','
}

/** `1,234` / `(56)` / `12%` / `3.2 万` 都按数值读 */
export function parseNumber(cell: string): number | null {
  let source = cell.trim()
  if (!source || source === '-' || source === '—') return null
  const negative = /^\(.*\)$/.test(source)
  source = source.replace(/[(),，\s]/g, '')
  const suffix = source.match(/(万|亿|%)$/)?.[1]
  if (suffix) source = source.slice(0, -1)
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(source)) return null
  let number = Number(source)
  if (!Number.isFinite(number)) return null
  if (negative) number *= -1
  if (suffix === '万') number *= 10_000
  if (suffix === '亿') number *= 100_000_000
  return number
}

/**
 * 解析表格文本（首行表头，首列是类目）。
 *
 * ```
 * 月份,收入,支出
 * 1 月,120,80
 * ```
 */
export function parseChartTable(source: string): CanvasChartSpec | null {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    // 结束 Markdown 表格的分隔行（|---|---|）
    .filter((line) => line && !/^\|?[\s:|-]+\|?$/.test(line))

  if (lines.length < 2) return null
  const delimiter = detectDelimiter(lines[0])
  const normalize = (cells: string[]) => cells.map((cell) => cell.replace(/^\||\|$/g, '').trim())

  const header = normalize(splitLine(lines[0], delimiter))
  if (header.length < 2) return null
  const series = header.slice(1).map((name) => ({ name }))

  const data: CanvasChartDatum[] = []
  for (const line of lines.slice(1)) {
    const cells = normalize(splitLine(line, delimiter))
    if (cells.length < 2) continue
    const values = series.map((_, index) => parseNumber(cells[index + 1] ?? '') ?? 0)
    data.push({ label: cells[0] || `第 ${data.length + 1} 项`, values })
  }
  if (data.length === 0) return null

  return { type: 'bar', title: '', categoryLabel: header[0] || '类目', series, data }
}

/** 反向生成表格文本，供编辑面板回填 */
export function chartToTable(spec: CanvasChartSpec): string {
  const header = [spec.categoryLabel || '类目', ...spec.series.map((item) => item.name)]
  const rows = spec.data.map((datum) => [
    datum.label,
    ...spec.series.map((_, index) => String(datum.values[index] ?? 0)),
  ])
  return [header, ...rows].map((cells) => cells.join(',')).join('\n')
}
