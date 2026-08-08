import { cn } from '@/lib/utils'

export interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  className?: string
}

export function Skeleton({ width, height = 14, radius = 4, className }: SkeletonProps) {
  return (
    <span
      className={cn(
        'block bg-[linear-gradient(90deg,var(--surface-2)_25%,var(--surface-3)_37%,var(--surface-2)_63%)] bg-[length:400px_100%] animate-[forge-shimmer_1.4s_ease_infinite]',
        className,
      )}
      style={{ width: width ?? '100%', height, borderRadius: radius }}
    />
  )
}

/** Convenience: a stack of text-line skeletons. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  )
}
