import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'

import { cn } from '@/lib/utils'
import { Button } from './button'

/* ---------------- Tabs ---------------- */

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex h-8 items-center gap-1 rounded-lg bg-muted p-0.5', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-7 items-center justify-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors',
        'hover:text-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

export const TabsContent = TabsPrimitive.Content

/* ---------------- Switch ---------------- */

export function Switch({ className, ...props }: React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'dbx-switch peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="dbx-switch-thumb pointer-events-none block rounded-full bg-background shadow-sm ring-0 transition-transform" />
    </SwitchPrimitive.Root>
  )
}

/* ---------------- AlertDialog ---------------- */

export const AlertDialog = AlertDialogPrimitive.Root

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive = true,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-3',
            'rounded-xl bg-popover p-5 text-sm shadow-lg ring-1 ring-foreground/10 outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <AlertDialogPrimitive.Title className="text-base font-semibold">{title}</AlertDialogPrimitive.Title>
          {description ? (
            <AlertDialogPrimitive.Description className="text-sm text-muted-foreground">
              {description}
            </AlertDialogPrimitive.Description>
          ) : null}
          <div className="mt-1 flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="outline" size="sm" onClick={onCancel}>
                {cancelLabel}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant={destructive ? 'destructive' : 'default'} size="sm" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  )
}

/* ---------------- Badge / Separator / Spinner ---------------- */

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div className={cn(vertical ? 'h-4 w-px bg-border' : 'h-px w-full bg-border', className)} />
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60',
        className,
      )}
      role="status"
      aria-label="加载中"
    />
  )
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  )
}
