import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/** 按钮样式配方：与桌面端一致的紧凑尺寸与中性配色 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        outline: 'border-border bg-background hover:bg-muted hover:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/70',
        ghost: 'hover:bg-muted hover:text-foreground',
        destructive: 'bg-destructive/10 text-destructive hover:bg-destructive/20',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-2.5',
        sm: 'h-7 rounded-md px-2.5 text-[0.8rem] [&_svg:not([class*="size-"])]:size-3.5',
        xs: 'h-6 rounded-md px-2 text-xs [&_svg:not([class*="size-"])]:size-3',
        lg: 'h-9 px-3',
        icon: 'size-8',
        'icon-sm': 'size-7 rounded-md',
        'icon-xs': 'size-6 rounded-md [&_svg:not([class*="size-"])]:size-3.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type = 'button', ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
})

export { buttonVariants }
