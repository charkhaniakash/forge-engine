import { useState } from 'react'
import { DiffViewer, Icon } from '@/components/common'
import type { FileChangeVM } from './model'
import { cn } from '@/lib/utils'

export interface FileChangesProps {
  files: FileChangeVM[]
}

const OP_BADGE: Record<string, string> = {
  create: 'bg-success/10 text-success',
  modify: 'bg-info/10 text-info',
  delete: 'bg-destructive/10 text-destructive',
  rename: 'bg-warning/10 text-warning',
}

/** Modified files with inline diff expansion — never leaves the task page. */
export function FileChanges({ files }: FileChangesProps) {
  const [open, setOpen] = useState<string | null>(null)

  if (files.length === 0) {
    return <div className="px-1 py-2 text-xs text-fg-subtle">No file changes yet.</div>
  }

  const totalAdd = files.reduce((a, f) => a + f.linesAdded, 0)
  const totalDel = files.reduce((a, f) => a + f.linesRemoved, 0)

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-1 pb-2 text-xs text-fg-subtle">
        <span>{files.length} file{files.length === 1 ? '' : 's'} changed</span>
        <span className="font-mono">
          <span className="text-success">+{totalAdd}</span>{' '}
          <span className="text-destructive">−{totalDel}</span>
        </span>
      </div>

      <div className="flex flex-col gap-px">
        {files.map((f) => {
          const expanded = open === f.path
          return (
            <div key={f.path} className="overflow-hidden rounded-md">
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 disabled:cursor-default"
                onClick={() => setOpen(expanded ? null : f.path)}
                disabled={!f.diff}
              >
                {f.diff && (
                  <Icon
                    name="chevronRight"
                    size={13}
                    className={cn('flex-shrink-0 text-fg-subtle transition-transform duration-150', expanded && 'rotate-90')}
                  />
                )}
                <span className={cn('flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase', OP_BADGE[f.operation] ?? OP_BADGE.modify)}>
                  {f.operation.charAt(0)}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{f.path}</code>
                {f.revisions != null && f.revisions > 1 && (
                  <span className="flex-shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-fg-subtle">×{f.revisions}</span>
                )}
                <span className="flex-shrink-0 font-mono text-[11px]">
                  <span className="text-success">+{f.linesAdded}</span>{' '}
                  <span className="text-destructive">−{f.linesRemoved}</span>
                </span>
              </button>
              {expanded && f.diff && (
                <div className="mt-1 overflow-hidden rounded-md border border-border">
                  <DiffViewer diff={f.diff} hideFileHeader maxHeight={360} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
