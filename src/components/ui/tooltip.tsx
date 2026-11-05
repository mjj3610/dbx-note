import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as PopoverPrimitive from '@radix-ui/react-popover'

import { cn } from '@/lib/utils'

/** 工具提示根节点（App 顶层挂 Provider） */
export function TooltipProvider({
  children,
  delayDuration = 0,
}: {
  children: React.ReactNode
  delayDuration?: number
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({
  className,
  sideOffset = 0,
  children,
  style,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        // 背景/文字色走内联变量而不是 `bg-foreground text-background`：
        // 本项目的主题里 `background` 没有生成 `text-*` 工具类，用类名会退化成继承色，
        // 结果就是「近黑底 + 近黑字」的一整块黑（用户反馈的那个黑色提示）。
        style={{
          backgroundColor: 'hsl(var(--foreground))',
          color: 'hsl(var(--background))',
          ...style,
        }}
        className={cn(
          // 与复刻项目一致：紧凑胶囊 + 小箭头，浮在按钮上方
          'z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5',
          'rounded-md px-3 py-1.5 text-xs shadow-md',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
          'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]"
          style={{ fill: 'hsl(var(--foreground))' }}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/** 带 tooltip 的图标按钮包装，省去重复模板代码 */
export function Hint({
  label,
  children,
  side = 'bottom',
  sideOffset,
}: {
  label: string
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  sideOffset?: number
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 w-72 rounded-lg bg-popover p-3 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
