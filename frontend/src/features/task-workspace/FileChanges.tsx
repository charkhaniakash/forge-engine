import { useState } from 'react'
import { DiffViewer, Icon } from '@/components/common'
import type { FileChangeVM } from './model'
import styles from './FileChanges.module.css'

export interface FileChangesProps {
  files: FileChangeVM[]
}

const OP_TONE: Record<string, string> = {
  create: 'create',
  modify: 'modify',
  delete: 'delete',
  rename: 'rename',
}

/** Modified files with inline diff expansion — never leaves the task page. */
export function FileChanges({ files }: FileChangesProps) {
  const [open, setOpen] = useState<string | null>(null)

  if (files.length === 0) {
    return <div className={styles.empty}>No file changes yet.</div>
  }

  const totalAdd = files.reduce((a, f) => a + f.linesAdded, 0)
  const totalDel = files.reduce((a, f) => a + f.linesRemoved, 0)

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <span className={styles.totals}>
          <span className={styles.add}>+{totalAdd}</span> <span className={styles.del}>−{totalDel}</span>
        </span>
      </div>
      {files.map((f) => {
        const expanded = open === f.path
        return (
          <div key={f.path} className={styles.file}>
            <button
              className={styles.fileHead}
              onClick={() => setOpen(expanded ? null : f.path)}
              disabled={!f.diff}
            >
              {f.diff && (
                <Icon
                  name="chevronRight"
                  size={13}
                  className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
                />
              )}
              <span className={styles.op} data-op={OP_TONE[f.operation] ?? 'modify'}>
                {f.operation}
              </span>
              <code className={styles.path}>{f.path}</code>
              {f.revisions != null && f.revisions > 1 && (
                <span className={styles.revisions}>×{f.revisions}</span>
              )}
              <span className={styles.stat}>
                <span className={styles.add}>+{f.linesAdded}</span>{' '}
                <span className={styles.del}>−{f.linesRemoved}</span>
              </span>
            </button>
            {expanded && f.diff && <DiffViewer diff={f.diff} hideFileHeader maxHeight={360} />}
          </div>
        )
      })}
    </div>
  )
}
