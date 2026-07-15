import { Fragment } from 'react'
import { Icon } from '@/components/common'
import { useGetGitStatusQuery, useGetGitDiffQuery } from '@/services/api/workspaceEditorApi'
import styles from './workspace.module.css'

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className={styles.diff}>
      {diff.split('\n').map((line, i) => {
        let cls = ''
        if (line.startsWith('+') && !line.startsWith('+++')) cls = styles.diffAdd
        else if (line.startsWith('-') && !line.startsWith('---')) cls = styles.diffDel
        else if (line.startsWith('@@')) cls = styles.diffHunk
        return (
          <span key={i} className={cls}>
            {line || ' '}
          </span>
        )
      })}
    </pre>
  )
}

export function GitPanel({ workspaceId }: { workspaceId: string }) {
  const { data: status } = useGetGitStatusQuery(workspaceId, { skip: !workspaceId })
  const { data: diffData } = useGetGitDiffQuery(workspaceId, { skip: !workspaceId })

  const groups: Array<{ label: string; files: string[]; mark: string; cls: string }> = [
    { label: 'Staged', files: status?.staged ?? [], mark: '+', cls: styles.markStaged },
    { label: 'Modified', files: status?.modified ?? [], mark: 'M', cls: styles.markMod },
    { label: 'Untracked', files: status?.untracked ?? [], mark: '?', cls: styles.markUntracked },
  ]

  const hasChanges = groups.some((g) => g.files.length > 0)

  return (
    <div>
      <div className={styles.gitSummary}>
        <span className={styles.gitCount}>
          <Icon name="branch" size={12} /> {status?.branch ?? '—'}
        </span>
      </div>
      {!hasChanges && <div className={styles.empty}>Working tree clean.</div>}
      {groups.map((g) =>
        g.files.length > 0 ? (
          <Fragment key={g.label}>
            <div className={styles.panelHeader}>{g.label} · {g.files.length}</div>
            {g.files.map((f) => (
              <div key={f} className={styles.gitFileRow} title={f}>
                <span className={`${styles.gitMark} ${g.cls}`}>{g.mark}</span>
                <span className={styles.treeName}>{f}</span>
              </div>
            ))}
          </Fragment>
        ) : null,
      )}
      {diffData?.diff && diffData.diff.trim() !== '' && (
        <>
          <div className={styles.panelHeader}>Diff</div>
          <DiffView diff={diffData.diff} />
        </>
      )}
    </div>
  )
}
