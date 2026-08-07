import { Fragment } from 'react'
import { Icon } from '@/components/common'
import { useGetGitStatusQuery, useGetGitDiffQuery } from '@/services/api/workspaceEditorApi'
import { cn } from '@/lib/utils'

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto bg-inset p-2 font-mono text-[11px] leading-relaxed">
      {diff.split('\n').map((line, i) => {
        let cls = 'text-fg-muted'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-success'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-destructive'
        else if (line.startsWith('@@')) cls = 'text-info'
        return (
          <span key={i} className={cn('block', cls)}>
            {line || ' '}
          </span>
        )
      })}
    </pre>
  )
}

const MARK_COLOR: Record<string, string> = {
  Staged: 'text-success',
  Modified: 'text-info',
  Untracked: 'text-warning',
}

export function GitPanel({ workspaceId }: { workspaceId: string }) {
  const { data: status } = useGetGitStatusQuery(workspaceId, { skip: !workspaceId })
  const { data: diffData } = useGetGitDiffQuery(workspaceId, { skip: !workspaceId })

  const groups: Array<{ label: string; files: string[]; mark: string }> = [
    { label: 'Staged', files: status?.staged ?? [], mark: '+' },
    { label: 'Modified', files: status?.modified ?? [], mark: 'M' },
    { label: 'Untracked', files: status?.untracked ?? [], mark: '?' },
  ]

  const hasChanges = groups.some((g) => g.files.length > 0)

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b border-line-subtle px-3 py-2 font-mono text-xs text-fg-muted">
        <Icon name="branch" size={12} className="text-fg-subtle" /> {status?.branch ?? '—'}
      </div>
      {!hasChanges && <div className="p-4 text-xs text-fg-subtle">Working tree clean.</div>}
      {groups.map((g) =>
        g.files.length > 0 ? (
          <Fragment key={g.label}>
            <div className="px-3 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
              {g.label} · {g.files.length}
            </div>
            {g.files.map((f) => (
              <div key={f} className="flex items-center gap-2 px-3 py-1 hover:bg-surface-2" title={f}>
                <span className={cn('flex-shrink-0 font-mono text-xs font-bold', MARK_COLOR[g.label])}>{g.mark}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{f}</span>
              </div>
            ))}
          </Fragment>
        ) : null,
      )}
      {diffData?.diff && diffData.diff.trim() !== '' && (
        <>
          <div className="border-t border-line-subtle px-3 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            Diff
          </div>
          <DiffView diff={diffData.diff} />
        </>
      )}
    </div>
  )
}
