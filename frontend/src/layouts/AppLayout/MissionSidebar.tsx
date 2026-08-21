import { NavLink, useNavigate } from 'react-router-dom'
import { Icon, Dropdown, Tooltip, StatusBadge } from '@/components/common'
import { ForgeMark } from '@/components/common/ForgeMark/ForgeMark'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { themeToggled } from '@/store/slices/uiSlice'
import { loggedOut } from '@/store/slices/authSlice'
import { useAuth } from '@/hooks/useAuth'
import { useListMissionsQuery } from '@/services/api/taskApi'
import { useListReposQuery } from '@/services/api/repositoryApi'
import { WORK_ITEM_STATUS } from '@/constants/status'
import { ROUTES, routeTo } from '@/constants/routes'
import { cn } from '@/lib/utils'

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
    <aside className="flex h-screen w-[248px] shrink-0 flex-col border-r border-line bg-base">
      {/* User + new session */}
      <div className="flex flex-col gap-2 px-3 py-3">
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
              id: 'repos',
              label: 'Repositories',
              icon: <Icon name="repo" size={14} />,
              onSelect: () => navigate(ROUTES.repositories),
            },
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
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface"
            >
              <img
                src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user?.name ?? 'U')}&backgroundColor=3B82F6&textColor=ffffff&fontSize=40`}
                alt=""
                className="h-7 w-7 shrink-0 rounded-full"
              />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                {user?.name ?? 'Account'}
              </span>
              <Icon name="chevronDown" size={14} className="shrink-0 text-fg-subtle" />
            </button>
          )}
        />

        <button
          onClick={() => navigate(ROUTES.root)}
          className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
        >
          <Icon name="plus" size={15} />
          New session
        </button>
      </div>

      {/* Nav links — minimal */}
      <nav className="space-y-0.5 px-2">
        {[
          { label: 'Repositories', icon: 'repo' as const, path: ROUTES.repositories },
          { label: 'Settings', icon: 'settings' as const, path: ROUTES.settings },
        ].map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
                isActive ? 'bg-surface text-fg' : 'text-fg-muted hover:bg-surface hover:text-fg',
              )
            }
          >
            <Icon name={item.icon} size={15} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Recent */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 pb-2">
          <span className="text-[12px] font-medium text-fg-subtle">Recent</span>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {isLoading && (
            <div className="px-3 py-4 text-[12px] text-fg-subtle">Loading…</div>
          )}
          {!isLoading && missions.length === 0 && (
            <div className="px-3 py-8 text-center text-[12px] text-fg-subtle">
              No sessions yet
            </div>
          )}
          {missions.map((m) => (
            <NavLink
              key={m.id}
              to={routeTo.mission(m.id) + `?repo=${m.repo_id}`}
              className={({ isActive }) =>
                cn(
                  'block rounded-lg px-3 py-2 transition-colors',
                  isActive ? 'bg-surface' : 'hover:bg-surface/80',
                )
              }
            >
              <p className="truncate text-[13px] text-fg">{m.intent}</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[10px] text-fg-subtle">
                  {repoName(m.repo_id)}
                </span>
                <StatusBadge map={WORK_ITEM_STATUS} status={m.status} dot={false} size="sm" />
              </div>
            </NavLink>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-line-subtle p-2">
        <div className="flex items-center gap-2 px-2">
          <ForgeMark size="sm" />
          <span className="text-[11px] font-medium text-fg-subtle">Forge</span>
        </div>
        <Tooltip content={theme === 'dark' ? 'Light mode' : 'Dark mode'} side="top">
          <button
            onClick={() => dispatch(themeToggled())}
            aria-label="Toggle theme"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface hover:text-fg"
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
          </button>
        </Tooltip>
      </div>
    </aside>
  )
}
