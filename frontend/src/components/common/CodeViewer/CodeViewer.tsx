import { cn } from '@/lib/utils'

export interface CodeViewerProps {
  code: string
  language?: string
  /** Show a line-number gutter. */
  showLineNumbers?: boolean
  /** 1-based line to highlight (e.g. a citation start). */
  highlightStart?: number
  highlightEnd?: number
  maxHeight?: number
  filename?: string
}

/**
 * Plain code renderer with line numbers and optional line-range highlight.
 * Syntax highlighting is intentionally deferred (Phase 11) — the DOM structure
 * is token-ready so a highlighter can drop in without markup changes.
 */
export function CodeViewer({
  code,
  language,
  showLineNumbers = true,
  highlightStart,
  highlightEnd,
  maxHeight = 480,
  filename,
}: CodeViewerProps) {
  const lines = code.replace(/\n$/, '').split('\n')
  const hlEnd = highlightEnd ?? highlightStart
  return (
    <div className="overflow-hidden rounded-md border border-line-subtle bg-inset">
      {filename && (
        <div className="flex items-center justify-between border-b border-line-subtle bg-surface-2 px-3 py-2 font-mono text-xs text-fg-muted">
          <span>{filename}</span>
          {language && <span className="text-[11px] uppercase text-fg-subtle">{language}</span>}
        </div>
      )}
      <div className="overflow-auto" style={{ maxHeight }}>
        <pre className="m-0 font-mono text-xs leading-relaxed">
          {lines.map((line, i) => {
            const no = i + 1
            const highlighted =
              highlightStart != null && no >= highlightStart && no <= (hlEnd ?? highlightStart)
            return (
              <div key={i} className={cn('flex', highlighted && 'bg-primary/10')}>
                {showLineNumbers && (
                  <span className="w-11 flex-shrink-0 pr-3 text-right text-fg-subtle select-none">
                    {no}
                  </span>
                )}
                <span className="whitespace-pre pr-4 text-fg">{line || ' '}</span>
              </div>
            )
          })}
        </pre>
      </div>
    </div>
  )
}
