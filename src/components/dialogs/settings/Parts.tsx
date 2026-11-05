/**
 * 设置页共用版式
 *
 * 对齐 NoteGen 的设置页结构：页面标题 + 说明，分组标题 + 说明，
 * 每一项是一张卡片：左侧图标，中间标题与描述，右侧操作控件。
 */
import type { LucideIcon } from 'lucide-react'

import { Label } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** 页面级标题（NoteGen 的 SettingType） */
export function SettingPage({
  title,
  desc,
  action,
  children,
}: {
  title: string
  desc?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {desc ? (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{desc}</p>
          ) : null}
        </div>
        {action}
      </header>
      {children}
    </div>
  )
}

/** 分组标题（NoteGen 的 SettingSection） */
export function SettingSection({
  title,
  desc,
  action,
  children,
}: {
  title?: string
  desc?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      {title ? (
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[13px] font-medium">{title}</h3>
            {desc ? (
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{desc}</p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      <div className="space-y-2">{children}</div>
    </section>
  )
}

/** 单项卡片（NoteGen 的 Item）：图标 + 标题 + 描述 + 右侧操作 */
export function SettingItem({
  icon: Icon,
  title,
  desc,
  children,
  disabled,
  stacked,
}: {
  icon?: LucideIcon
  title: string
  desc?: string
  children?: React.ReactNode
  disabled?: boolean
  /** 操作区换行到下一行（表单类） */
  stacked?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border px-3 py-2 transition-opacity',
        disabled && 'opacity-60',
        stacked ? 'space-y-2' : 'flex items-center gap-3',
      )}
    >
      <div className={cn('flex items-center gap-3', stacked ? '' : 'min-w-0 flex-1')}>
        {Icon ? (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-3.5" />
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{title}</div>
          {desc ? (
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{desc}</p>
          ) : null}
        </div>
      </div>
      {children ? (
        <div className={cn(stacked ? '' : 'ml-auto flex shrink-0 items-center gap-2')}>{children}</div>
      ) : null}
    </div>
  )
}

/** 分段按钮（NoteGen 的 ToggleGroup 单选） */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (next: T) => void
  /** 无障碍名称，同时作为测试定位依据 */
  label: string
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex flex-wrap rounded-lg bg-muted p-0.5', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.label}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 rounded-md px-2.5 text-xs transition-colors disabled:cursor-not-allowed',
            value === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 带标题的输入行 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}
