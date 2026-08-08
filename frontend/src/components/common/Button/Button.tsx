import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from '../Spinner/Spinner'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'subtle'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  block?: boolean
  iconOnly?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground enabled:hover:bg-[var(--accent-hover)] enabled:active:bg-[var(--accent-active)]',
  secondary:
    'bg-surface-2 text-fg border-line enabled:hover:bg-surface-3 enabled:hover:border-line-strong',
  ghost: 'bg-transparent text-fg-muted enabled:hover:bg-surface-2 enabled:hover:text-fg',
  danger: 'bg-destructive text-white enabled:hover:brightness-110',
  subtle: 'bg-primary/10 text-primary enabled:hover:brightness-125',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-7 px-3 text-[12px]',
  md: 'h-[34px] px-4',
  lg: 'h-10 px-5 text-[14px]',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'secondary',
      size = 'md',
      loading = false,
      block = false,
      iconOnly = false,
      leadingIcon,
      trailingIcon,
      disabled,
      children,
      className,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-2 border border-transparent rounded-md font-medium text-[13px] leading-none whitespace-nowrap select-none cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed',
          variantClasses[variant],
          sizeClasses[size],
          block && 'w-full',
          iconOnly && 'p-0 aspect-square',
          className,
        )}
        disabled={disabled || loading}
        {...rest}
      >
        {loading ? (
          <Spinner size={size === 'lg' ? 16 : 14} />
        ) : (
          leadingIcon
        )}
        {!iconOnly && children}
        {!loading && trailingIcon}
      </button>
    )
  },
)
