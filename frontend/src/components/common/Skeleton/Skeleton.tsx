import styles from './Skeleton.module.css'

export interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  className?: string
}

export function Skeleton({ width, height = 14, radius = 4, className }: SkeletonProps) {
  return (
    <span
      className={`${styles.skeleton} ${className ?? ''}`}
      style={{ width: width ?? '100%', height, borderRadius: radius }}
    />
  )
}

/** Convenience: a stack of text-line skeletons. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className={styles.stack}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  )
}
