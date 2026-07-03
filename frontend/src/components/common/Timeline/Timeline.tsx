import type { ReactNode } from 'react'
import type { Tone } from '@/constants/status'
import styles from './Timeline.module.css'

export interface TimelineItemData {
  id: string
  tone?: Tone
  /** Custom node icon; falls back to a toned dot. */
  marker?: ReactNode
  title: ReactNode
  meta?: ReactNode
  body?: ReactNode
  active?: boolean
  onClick?: () => void
}

export interface TimelineProps {
  items: TimelineItemData[]
  /** Show a pulsing marker on the active item (live executions). */
  live?: boolean
}

export function Timeline({ items, live = false }: TimelineProps) {
  return (
    <ol className={styles.timeline}>
      {items.map((item, i) => (
        <li
          key={item.id}
          className={`${styles.item} ${item.active ? styles.activeItem : ''} ${
            item.onClick ? styles.clickable : ''
          }`}
          onClick={item.onClick}
        >
          <div className={styles.rail}>
            <span
              className={`${styles.marker} ${styles[item.tone ?? 'neutral']} ${
                live && item.active ? styles.pulse : ''
              }`}
            >
              {item.marker}
            </span>
            {i < items.length - 1 && <span className={styles.line} />}
          </div>
          <div className={styles.content}>
            <div className={styles.head}>
              <span className={styles.title}>{item.title}</span>
              {item.meta && <span className={styles.meta}>{item.meta}</span>}
            </div>
            {item.body && <div className={styles.body}>{item.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}
