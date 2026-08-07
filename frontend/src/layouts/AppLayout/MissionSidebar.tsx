import { NavLink, useNavigate } from 'react-router-dom'
import { Icon, Dropdown, Tooltip } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { themeToggled } from '@/store/slices/uiSlice'
import { loggedOut } from '@/store/slices/authSlice'
import { useAuth } from '@/hooks/useAuth'
import { useListMissionsQuery } from '@/services/api/taskApi'
import { useListReposQuery } from '@/services/api/repositoryApi'
import { WORK_ITEM_STATUS } from '@/constants/status'
import { ROUTES, routeTo } from '@/constants/routes'

// Map StatusMeta.tone → a CSS color variable (StatusMeta has no .color field)
const TONE_TO_COLOR: Record<string, string> = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger:  'var(--danger)',
  info:    'var(--info)',
  accent:  'var(--accent)',
  neutral: 'var(--text-tertiary)',
}

export function MissionSidebar() {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { user } = useAuth()
  const theme = useAppSelector((s) => s.ui.theme)

  const missionsResult = useListMissionsQuery(undefined, { pollingInterval: 15000 })
  const missions = missionsResult.data ?? []
  const isLoading = missionsResult.isLoading

  const reposResult = useListReposQuery()
  const repos = reposResult.data ?? []
  const repoName = (repoId: string) =>
    repos.find((r) => r.id === repoId)?.repo_full_name ?? 'repository'

  return (
    <aside className="flex h-screen w-[272px] flex-shrink-0 flex-col border-r border-line bg-surface">
      {/* ── Top: Brand + New Task ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 border-b border-line-subtle p-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary font-mono text-sm font-bold text-primary-foreground">
            F
          </div>
          <span className="font-mono text-sm font-bold tracking-wide text-fg">FORGE</span>
          <span className="ml-auto rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-subtle">
            v0.9.4
          </span>
        </div>

        <div className="flex items-center gap-2 px-0.5">
          <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle" />
          <span className="text-xs text-fg-subtle">Agent idle</span>
        </div>

        <button
          onClick={() => navigate(ROUTES.root)}
          className="flex h-9 items-center justify-center gap-2 rounded-lg bg-primary text-[13px] font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-[0.98] cursor-pointer"
        >
          <Icon name="plus" size={16} />
          <span>New task</span>
        </button>
      </div>

      {/* ── Recent Sessions ──────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 pb-2 pt-4 font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
          Recent sessions
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {isLoading && <div className="px-2 py-3 text-xs text-fg-subtle">Loading…</div>}
          {!isLoading && missions.length === 0 && (
            <div className="px-2 py-3 text-xs text-fg-subtle">No missions yet</div>
          )}
          {missions.map((m) => {
            const meta = WORK_ITEM_STATUS[m.status as keyof typeof WORK_ITEM_STATUS]
            const statusLabel = meta?.label ?? m.status
            const statusColor = meta ? (TONE_TO_COLOR[meta.tone] ?? 'var(--text-tertiary)') : 'var(--text-tertiary)'
            return (
              <NavLink
                key={m.id}
                to={routeTo.mission(m.id) + `?repo=${m.repo_id}`}
                className={({ isActive }) =>
                  [
                    'group block rounded-lg border px-2.5 py-2 transition-colors duration-150',
                    isActive
                      ? 'border-line-subtle bg-surface-2'
                      : 'border-transparent hover:bg-surface-2/60',
                  ].join(' ')
                }
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                    {m.intent}
                  </span>
                  <span
                    className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{
                      color: statusColor,
                      background: `color-mix(in srgb, ${statusColor} 14%, transparent)`,
                    }}
                  >
                    {statusLabel}
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-fg-subtle">
                  {repoName(m.repo_id)}
                </p>
              </NavLink>
            )
          })}
        </div>
      </div>

      {/* ── Agent Stats + Account Footer ─────────────────────────────────── */}
      <div className="border-t border-line-subtle">
        <div className="grid grid-cols-3 gap-px border-b border-line-subtle bg-line-subtle">
          {[
            { label: 'CPU', value: '4.2%', accent: false },
            { label: 'RAM', value: '1.8 GB', accent: false },
            { label: 'Sandbox', value: 'Active', accent: true },
          ].map((s) => (
            <div key={s.label} className="flex flex-col gap-0.5 bg-surface px-3 py-2.5">
              <span className="font-mono text-[9px] uppercase tracking-wide text-fg-subtle">
                {s.label}
              </span>
              <span
                className={`font-mono text-xs font-medium ${s.accent ? 'text-primary' : 'text-fg-muted'}`}
              >
                {s.value}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1 p-2.5">
          <Dropdown
            align="start"
            width={220}
            header={
              <div>
                <div className="text-sm font-semibold text-fg">{user?.name}</div>
                <div className="text-xs text-fg-subtle">{user?.email}</div>
              </div>
            }
            items={[
              {
                id: 'settings',
                label: 'Settings',
                icon: <Icon name="settings" size={14} />,
                onSelect: () => navigate(ROUTES.settings),
              },
              {
                id: 'logout',
                label: 'Log out',
                icon: <Icon name="logout" size={14} />,
                danger: true,
                divider: true,
                onSelect: () => {
                  dispatch(loggedOut())
                  navigate(ROUTES.login)
                },
              },
            ]}
            trigger={({ toggle }) => (
              <button
                onClick={toggle}
                aria-label="Account"
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2 cursor-pointer"
              >
                <img
                  src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user?.name ?? 'U')}&backgroundColor=22C55E&textColor=04180C&fontSize=40`}
                  alt={user?.name?.[0] ?? '?'}
                  className="h-7 w-7 flex-shrink-0 rounded-full"
                />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-fg">
                    {user?.name ?? 'Account'}
                  </span>
                  <span className="truncate text-[11px] text-fg-subtle">{user?.email}</span>
                </div>
              </button>
            )}
          />
          <Tooltip content={theme === 'dark' ? 'Light mode' : 'Dark mode'} side="top">
            <button
              onClick={() => dispatch(themeToggled())}
              aria-label="Toggle theme"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors duration-150 hover:bg-surface-2 hover:text-fg cursor-pointer"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
    </aside>
  )
}
