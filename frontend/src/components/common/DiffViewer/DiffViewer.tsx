import { useMemo } from 'react'
import { cn } from '@/lib/utils'

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

const ROW_CLASS: Record<LineKind, string> = {
  add: 'bg-success/10',
  del: 'bg-destructive/10',
  hunk: 'bg-surface-2',
  meta: '',
  context: '',
}

const CODE_CLASS: Record<LineKind, string> = {
  add: 'text-success',
  del: 'text-destructive',
  hunk: 'text-info',
  meta: 'text-fg-subtle',
  context: 'text-fg-muted',
}

export function DiffViewer({ diff, hideFileHeader = false, maxHeight = 480 }: DiffViewerProps) {
  const lines = useMemo(() => {
    const parsed = parse(diff)
    return hideFileHeader ? parsed.filter((l) => l.kind !== 'meta') : parsed
  }, [diff, hideFileHeader])

  return (
    <div
      className="overflow-auto rounded-md bg-inset font-mono text-xs leading-relaxed"
      style={{ maxHeight }}
    >
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className={ROW_CLASS[line.kind]}>
              <td className="w-[1%] whitespace-nowrap border-r border-line-subtle px-2 text-right align-top text-fg-subtle select-none">
                {line.oldNo ?? ''}
              </td>
              <td className="w-[1%] whitespace-nowrap border-r border-line-subtle px-2 text-right align-top text-fg-subtle select-none">
                {line.newNo ?? ''}
              </td>
              <td className={cn('w-full whitespace-pre-wrap break-words px-3 text-fg', CODE_CLASS[line.kind])}>
                {line.text || ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
