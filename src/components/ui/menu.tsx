import * as React from 'react'
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import * as ContextPrimitive from '@radix-ui/react-context-menu'
import { Check, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

const contentClass =
  'z-50 min-w-44 overflow-hidden rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 ' +
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 ' +
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0'

const itemClass =
  'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none ' +
  'data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ' +
  '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

/* ---------------- Dropdown ---------------- */

export const DropdownMenu = DropdownPrimitive.Root
export const DropdownMenuTrigger = DropdownPrimitive.Trigger

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(contentClass, className)}
        {...props}
      />
    </DropdownPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  inset,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { inset?: boolean }) {
  return (
    <DropdownPrimitive.Item className={cn(itemClass, inset && 'pl-8', className)} {...props} />
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.CheckboxItem>) {
  return (
    <DropdownPrimitive.CheckboxItem className={cn(itemClass, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownPrimitive.ItemIndicator>
          <Check className="size-3.5 text-foreground" />
        </DropdownPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownPrimitive.CheckboxItem>
  )
}

/** 二级菜单（「转换为 ›」这类） */
export const DropdownMenuSub = DropdownPrimitive.Sub

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.SubTrigger>) {
  return (
    <DropdownPrimitive.SubTrigger
      className={cn(itemClass, 'data-[state=open]:bg-muted', className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-3.5" />
    </DropdownPrimitive.SubTrigger>
  )
}

export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.SubContent>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.SubContent
        sideOffset={4}
        className={cn(contentClass, 'min-w-40', className)}
        {...props}
      />
    </DropdownPrimitive.Portal>
  )
}

export const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.RadioItem>) {
  return (
    <DropdownPrimitive.RadioItem className={cn(itemClass, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownPrimitive.ItemIndicator>
          <Check className="size-3.5 text-foreground" />
        </DropdownPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownPrimitive.RadioItem>
  )
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Label>) {
  return (
    <DropdownPrimitive.Label
      className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>) {
  return <DropdownPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

/* ---------------- Context menu ---------------- */

export const ContextMenu = ContextPrimitive.Root
export const ContextMenuTrigger = ContextPrimitive.Trigger

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.Content>) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.Content className={cn(contentClass, className)} {...props} />
    </ContextPrimitive.Portal>
  )
}

export function ContextMenuItem({
  className,
  inset,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.Item> & { inset?: boolean }) {
  return <ContextPrimitive.Item className={cn(itemClass, inset && 'pl-8', className)} {...props} />
}

export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.Separator>) {
  return <ContextPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

export function ContextMenuLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.Label>) {
  return (
    <ContextPrimitive.Label
      className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

/** 右键菜单里的开关项（对应参考项目的显示开关） */
export function ContextMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.CheckboxItem>) {
  return (
    <ContextPrimitive.CheckboxItem className={cn(itemClass, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <ContextPrimitive.ItemIndicator>
          <Check className="size-3.5 text-foreground" />
        </ContextPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextPrimitive.CheckboxItem>
  )
}

/** 右键菜单的二级菜单（「排序 ›」「从模板新建 ›」「知识库 ›」） */
export const ContextMenuSub = ContextPrimitive.Sub

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.SubTrigger>) {
  return (
    <ContextPrimitive.SubTrigger
      className={cn(itemClass, 'data-[state=open]:bg-muted', className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-3.5" />
    </ContextPrimitive.SubTrigger>
  )
}

export function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextPrimitive.SubContent>) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.SubContent
        sideOffset={4}
        className={cn(contentClass, 'min-w-40', className)}
        {...props}
      />
    </ContextPrimitive.Portal>
  )
}

/** 菜单右侧的快捷键提示（Ctrl+X / F2 / Del） */
export function ContextMenuShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('ml-auto pl-4 text-[11px] tracking-widest text-muted-foreground', className)}
      {...props}
    />
  )
}
