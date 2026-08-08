export interface SpinnerProps {
  size?: number
  /** Stroke colour; defaults to currentColor. */
  color?: string
  label?: string
}

export function Spinner({ size = 16, color, label }: SpinnerProps) {
  return (
    <span
      className="inline-block border-solid border-[var(--border-strong)] border-t-current rounded-full shrink-0 animate-[forge-spin_0.7s_linear_infinite]"
      role="status"
      aria-label={label ?? 'Loading'}
      style={{
        width: size,
        height: size,
        borderWidth: Math.max(2, Math.round(size / 8)),
        borderTopColor: color ?? 'currentColor',
      }}
    />
  )
}
