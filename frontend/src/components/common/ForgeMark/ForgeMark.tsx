import { cn } from '@/lib/utils'

interface ForgeMarkProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizes = {
  sm: { box: 'h-7 w-7', icon: 14 },
  md: { box: 'h-9 w-9', icon: 18 },
  lg: { box: 'h-11 w-11', icon: 22 },
}

/** Distinct Forge logomark — stacked layers, not a copy of any competitor mark. */
export function ForgeMark({ size = 'md', className }: ForgeMarkProps) {
  const s = sizes[size]
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-[10px]',
        'bg-gradient-to-br from-primary/20 via-surface-2 to-surface-2',
        'ring-1 ring-line',
        s.box,
        className,
      )}
      aria-hidden
    >
      <svg
        width={s.icon}
        height={s.icon}
        viewBox="0 0 24 24"
        fill="none"
        className="text-primary"
      >
        <path
          d="M4 18h16M7 18V9l5-4 5 4v9"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 5v4M9.5 9h5"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}
