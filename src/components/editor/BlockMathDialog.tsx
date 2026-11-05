/**
 * 块级公式弹窗（对齐参考实现的「插入块级公式」）
 *
 * Σ 标题 + LaTeX 输入框（占位符带示例）+ KaTeX 实时预览 + 左下「常用公式示例」
 * 可点列表（点一下填进输入框）+ 取消 / 插入。空输入时「插入」禁用。
 */
import { useMemo, useState } from 'react'
import katex from 'katex'
import { Sigma, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MATH_EXAMPLES } from '@/lib/mathExamples'
import { useT } from '@/lib/useT'

/** LaTeX → HTML（渲染失败时返回 null，由调用方显示占位） */
function renderKatex(latex: string): string | null {
  try {
    return katex.renderToString(latex, {
      displayMode: true,
      throwOnError: true,
      strict: false,
    })
  } catch {
    return null
  }
}

export function BlockMathDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean
  onClose: () => void
  /** 把 LaTeX 作为块级公式节点插到光标处 */
  onInsert: (latex: string) => void
}) {
  const t = useT()
  const [value, setValue] = useState('')

  const preview = useMemo(() => (value.trim() ? renderKatex(value.trim()) : null), [value])

  if (!open) return null

  const submit = () => {
    const latex = value.trim()
    if (!latex) return
    onInsert(latex)
    setValue('')
    onClose()
  }

  return (
    <div
      data-math-dialog
      role="dialog"
      aria-modal="true"
      aria-label={t('math.title')}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-[480px] max-w-full rounded-xl bg-background p-4 shadow-2xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sigma className="size-4 text-primary" />
            {t('math.title')}
          </div>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="dbx-math-input">
          {t('math.latex')}
        </label>
        <Input
          id="dbx-math-input"
          autoFocus
          value={value}
          data-math-input
          placeholder={t('math.placeholder')}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
          className="mb-3 h-8 text-[13px]"
        />

        <span className="mb-1 block text-xs text-muted-foreground">{t('math.preview')}</span>
        <div
          data-math-preview
          className="mb-3 flex min-h-20 items-center justify-center rounded-lg border border-border bg-muted/40 px-3 py-3 text-[15px]"
        >
          {preview ? (
            <span dangerouslySetInnerHTML={{ __html: preview }} />
          ) : (
            <span className="text-xs text-muted-foreground">
              {value.trim() ? t('math.invalid') : t('math.previewEmpty')}
            </span>
          )}
        </div>

        <div className="mb-3 rounded-lg bg-muted/30 p-2.5">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('math.examples')}</p>
          <div className="flex flex-wrap gap-1">
            {MATH_EXAMPLES.map((item) => (
              <button
                key={item.label}
                type="button"
                data-math-example={item.label}
                title={item.latex}
                onClick={() => setValue(item.latex)}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!value.trim()} data-math-insert onClick={submit}>
            {t('common.insert')}
          </Button>
        </div>
      </div>
    </div>
  )
}
