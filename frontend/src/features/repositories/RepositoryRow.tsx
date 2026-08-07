import { Icon } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import type { Repository } from '@/types'

export interface RepositoryRowProps {
  repo: Repository
  onClick: () => void
}

/** A single repository line in the repositories list. */
export function RepositoryRow({ repo, onClick }: RepositoryRowProps) {
  return (
    <button
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-line-strong hover:bg-surface-2 cursor-pointer"
      onClick={onClick}
    >
      <Icon name="repo" size={18} className="flex-shrink-0 text-fg-subtle group-hover:text-primary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{repo.repo_full_name}</span>
          <Badge variant="secondary" className="flex-shrink-0 font-normal">
            {repo.private ? 'Private' : 'Public'}
          </Badge>
        </div>
        <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-fg-subtle">
          <span className="flex items-center gap-1">
            <Icon name="branch" size={12} /> {repo.default_branch}
          </span>
          {repo.last_synced_at && <span>Synced {new Date(repo.last_synced_at).toLocaleDateString()}</span>}
        </div>
      </div>
      <Icon name="chevronRight" size={16} className="flex-shrink-0 text-fg-subtle" />
    </button>
  )
}
