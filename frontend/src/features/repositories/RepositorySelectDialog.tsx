import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/common'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ROUTES } from '@/constants/routes'
import type { Repository } from '@/types'
import { cn } from '@/lib/utils'

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString()
}

export interface RepositorySelectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repos: Repository[]
  selectedId: string
  onConfirm: (repoId: string) => void
  loading?: boolean
}

export function RepositorySelectDialog({
  open,
  onOpenChange,
  repos,
  selectedId,
  onConfirm,
  loading,
}: RepositorySelectDialogProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [pendingId, setPendingId] = useState(selectedId)

  useEffect(() => {
    if (open) setPendingId(selectedId)
  }, [open, selectedId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos
    return repos.filter(
      (r) =>
        r.repo_full_name.toLowerCase().includes(q) ||
        r.repo_name.toLowerCase().includes(q) ||
        r.repo_owner.toLowerCase().includes(q),
    )
  }, [repos, query])

  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery('')
    onOpenChange(next)
  }

  const handleConfirm = () => {
    if (!pendingId) return
    onConfirm(pendingId)
    handleOpenChange(false)
  }

  const confirmLabel = pendingId ? 'Select 1 repository' : 'Select repository'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton
        className="gap-0 overflow-hidden rounded-xl border-line bg-surface p-0 shadow-2xl sm:max-w-[540px]"
      >
        <DialogHeader className="space-y-1.5 border-b border-line-subtle px-6 py-5 text-left">
          <DialogTitle className="text-[15px] font-semibold tracking-tight text-fg">
            Select repositories
          </DialogTitle>
          <DialogDescription className="max-w-[420px] text-[13px] leading-relaxed text-fg-muted">
            Tell Forge which repository it should work with in your session.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4">
          <div className="mb-3">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-fg ring-1 ring-line">
              Your repos
              <span className="font-mono text-[10px] text-fg-subtle">{repos.length}</span>
            </span>
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-base">
            {/* Search row — Devin-style integrated header */}
            <div className="flex items-center gap-2.5 border-b border-line-subtle px-3 py-2">
              <span className="w-[18px] shrink-0" aria-hidden />
              <div className="relative min-w-0 flex-1">
                <Icon
                  name="search"
                  size={14}
                  className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 text-fg-subtle"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search repositories…"
                  className="h-8 w-full bg-transparent pl-6 pr-2 text-[13px] text-fg outline-none placeholder:text-fg-subtle/60"
                />
              </div>
              <span className="hidden w-[108px] shrink-0 text-right text-[11px] text-fg-subtle sm:block">
                Last indexed
              </span>
            </div>

            <div className="max-h-[min(320px,46vh)] overflow-y-auto">
              {loading && (
                <div className="px-4 py-10 text-center text-[13px] text-fg-subtle">Loading…</div>
              )}
              {!loading && filtered.length === 0 && (
                <div className="px-4 py-10 text-center text-[13px] text-fg-subtle">
                  {query ? 'No repositories match your search' : 'No repositories connected'}
                </div>
              )}
              {!loading &&
                filtered.map((repo) => {
                  const selected = pendingId === repo.id
                  return (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => setPendingId(repo.id)}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2.5 border-b border-line-subtle px-3 py-3 text-left transition-colors last:border-b-0',
                        selected ? 'bg-surface-2/90' : 'hover:bg-surface-2/45',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                          selected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-line-strong bg-transparent',
                        )}
                      >
                        {selected && <Icon name="check" size={11} strokeWidth={2.5} />}
                      </span>

                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                        {repo.repo_name}
                      </span>

                      <span className="flex w-[108px] shrink-0 items-center justify-end gap-1.5 text-[11px] text-fg-subtle">
                        <Icon name="branch" size={12} className="opacity-70" />
                        <span className="truncate">{formatRelativeTime(repo.last_synced_at)}</span>
                      </span>
                    </button>
                  )
                })}
            </div>
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-3 border-t border-line-subtle px-6 py-4 sm:justify-between">
          <button
            type="button"
            onClick={() => {
              handleOpenChange(false)
              navigate(ROUTES.repositories)
            }}
            className="cursor-pointer text-[13px] text-fg-muted transition-colors hover:text-fg"
          >
            Manage repositories
          </button>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-fg-muted hover:text-fg"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 min-w-[148px] rounded-lg px-4 font-medium"
              disabled={!pendingId}
              onClick={handleConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
