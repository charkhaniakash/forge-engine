import { useMemo } from 'react'
import styles from './DiffViewer.module.css'

export interface DiffViewerProps {
  /** Unified diff text (git-style). */
  diff: string
  /** Hide the file header lines (---/+++/diff). */
  hideFileHeader?: boolean
  maxHeight?: number
}

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

interface DiffLine {
  kind: LineKind
  text: string
  oldNo?: number
  newNo?: number
}

function classify(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index '))
    return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

/** Parses a unified diff and tracks old/new line numbers per hunk. */
function parse(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of diff.split('\n')) {
    const kind = classify(raw)
    if (kind === 'hunk') {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) {
        oldNo = parseInt(m[1], 10)
        newNo = parseInt(m[2], 10)
      }
      out.push({ kind, text: raw })
      continue
    }
    if (kind === 'meta') {
      out.push({ kind, text: raw })
      continue
    }
    if (kind === 'add') {
      out.push({ kind, text: raw, newNo: newNo++ })
    } else if (kind === 'del') {
      out.push({ kind, text: raw, oldNo: oldNo++ })
    } else {
      out.push({ kind, text: raw, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return out
}

const KIND_CLASS: Record<LineKind, string> = {
  add: styles.add,
  del: styles.del,
  hunk: styles.hunk,
  meta: styles.meta,
  context: styles.context,
}

export function DiffViewer({ diff, hideFileHeader = false, maxHeight = 480 }: DiffViewerProps) {
  const lines = useMemo(() => {
    const parsed = parse(diff)
    return hideFileHeader ? parsed.filter((l) => l.kind !== 'meta') : parsed
  }, [diff, hideFileHeader])

  return (
    <div className={styles.root} style={{ maxHeight }}>
      <table className={styles.table}>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className={KIND_CLASS[line.kind]}>
              <td className={styles.gutter}>{line.oldNo ?? ''}</td>
              <td className={styles.gutter}>{line.newNo ?? ''}</td>
              <td className={styles.code}>{line.text || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
