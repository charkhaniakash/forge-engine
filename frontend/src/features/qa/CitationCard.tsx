import { Icon } from '@/components/common'
import type { Citation } from '@/types'

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
        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-fg-muted transition-colors hover:border-primary/30 hover:text-primary"
        title={`${citation.file_path}:${range}`}
        onClick={() => onClick?.(citation)}
      >
        <Icon name="file" size={11} />
        {citation.symbol_name ?? fileName(citation.file_path)}:{range}
      </button>
    )
  }

  return (
    <button
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
      onClick={() => onClick?.(citation)}
    >
      <Icon name="file" size={14} className="flex-shrink-0 text-fg-subtle" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-fg">{citation.file_path}</div>
        <div className="mt-0.5 font-mono text-[11px] text-fg-subtle">
          lines {range}
          {citation.symbol_name && ` · ${citation.symbol_name}`}
          {citation.language && ` · ${citation.language}`}
        </div>
      </div>
    </button>
  )
}
