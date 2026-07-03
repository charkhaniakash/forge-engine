import { Icon, Badge } from '@/components/common'
import type { Repository } from '@/types'
import styles from './RepositoryRow.module.css'

export interface RepositoryRowProps {
  repo: Repository
  onClick: () => void
}

/** A single repository line in the repositories list. */
export function RepositoryRow({ repo, onClick }: RepositoryRowProps) {
  return (
    <button className={styles.row} onClick={onClick}>
      <Icon name="repo" size={18} className={styles.icon} />
      <div className={styles.main}>
        <div className={styles.name}>
          {repo.repo_full_name}
          <Badge tone="neutral" size="sm">
            {repo.private ? 'Private' : 'Public'}
          </Badge>
        </div>
        <div className={styles.meta}>
          <span>
            <Icon name="branch" size={12} /> {repo.default_branch}
          </span>
          {repo.last_synced_at && (
            <span>Synced {new Date(repo.last_synced_at).toLocaleDateString()}</span>
          )}
        </div>
      </div>
      <Icon name="chevronRight" size={16} className={styles.chevron} />
    </button>
  )
}
