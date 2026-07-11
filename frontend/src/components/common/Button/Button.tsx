import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import styles from './Button.module.css'
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

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
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
        className={cx(
          styles.button,
          styles[variant],
          styles[size],
          block && styles.block,
          iconOnly && styles.iconOnly,
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
