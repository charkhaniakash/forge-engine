import { Icon } from '@/components/common'
import type { Citation } from '@/types'
import styles from './CitationCard.module.css'

export interface CitationCardProps {
  citation: Citation
  /** Compact chip (inline under a message) vs full row (citation viewer). */
  variant?: 'chip' | 'row'
  onClick?: (c: Citation) => void
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

export function CitationCard({ citation, variant = 'chip', onClick }: CitationCardProps) {
  const range =
    citation.start_line === citation.end_line
      ? `${citation.start_line}`
      : `${citation.start_line}–${citation.end_line}`

  if (variant === 'chip') {
    return (
      <button
        className={styles.chip}
        title={`${citation.file_path}:${range}`}
        onClick={() => onClick?.(citation)}
      >
        <Icon name="file" size={11} />
        {citation.symbol_name ?? fileName(citation.file_path)}:{range}
      </button>
    )
  }

  return (
    <button className={styles.row} onClick={() => onClick?.(citation)}>
      <Icon name="file" size={14} className={styles.rowIcon} />
      <div className={styles.rowMain}>
        <div className={styles.rowPath}>{citation.file_path}</div>
        <div className={styles.rowMeta}>
          lines {range}
          {citation.symbol_name && ` · ${citation.symbol_name}`}
          {citation.language && ` · ${citation.language}`}
        </div>
      </div>
    </button>
  )
}
