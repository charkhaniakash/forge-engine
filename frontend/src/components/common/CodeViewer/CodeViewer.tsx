import styles from './CodeViewer.module.css'

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
    <div className={styles.root}>
      {filename && (
        <div className={styles.header}>
          <span>{filename}</span>
          {language && <span className={styles.lang}>{language}</span>}
        </div>
      )}
      <div className={styles.scroll} style={{ maxHeight }}>
        <pre className={styles.pre}>
          {lines.map((line, i) => {
            const no = i + 1
            const highlighted =
              highlightStart != null && no >= highlightStart && no <= (hlEnd ?? highlightStart)
            return (
              <div key={i} className={`${styles.line} ${highlighted ? styles.hl : ''}`}>
                {showLineNumbers && <span className={styles.no}>{no}</span>}
                <span className={styles.text}>{line || ' '}</span>
              </div>
            )
          })}
        </pre>
      </div>
    </div>
  )
}
