import { NavLink, useNavigate } from 'react-router-dom'
import { Icon, Dropdown, Tooltip } from '@/components/common'
import type { IconName } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { themeToggled } from '@/store/slices/uiSlice'
import { loggedOut } from '@/store/slices/authSlice'
import { useAuth } from '@/hooks/useAuth'
import { useListMissionsQuery } from '@/services/api/taskApi'
import { useListReposQuery } from '@/services/api/repositoryApi'
import { WORK_ITEM_STATUS } from '@/constants/status'
import { ROUTES, routeTo } from '@/constants/routes'
import styles from './MissionSidebar.module.css'

const NAV: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: ROUTES.root, label: 'Console', icon: 'dashboard', end: true },
  { to: ROUTES.repositories, label: 'Repositories', icon: 'repo' },
]

export function MissionSidebar() {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { user, org } = useAuth()
  const theme = useAppSelector((s) => s.ui.theme)

  const missionsResult = useListMissionsQuery(undefined, {
    pollingInterval: 15000,
  })
  const missions = missionsResult.data ?? []
  const isLoading = missionsResult.isLoading
  const reposResult = useListReposQuery()
  const repos = reposResult.data ?? []
  const repoName = (repoId: string) =>
    repos.find((r) => r.id === repoId)?.repo_full_name ?? 'repository'

  const activeCount = missions.filter((m) =>
    ['planning', 'draft', 'plan_ready', 'plan_approved', 'executing', 'validating', 'repairing', 'publishing'].includes(m.status),
  ).length

  return (
    <aside className={styles.sidebar}>
      {/* ── Top: Brand + New Task ─────────────────────────────────────────── */}
      <div className={styles.top}>
        <div className={styles.brand}>
          <div className={styles.logo}>F</div>
          <span className={styles.brandName}>FORGE</span>
          <span className={styles.version}>v0.9.4</span>
        </div>
        <div className={styles.agentStatus}>
          <span className={styles.statusDot} />
          <span className={styles.statusLabel}>Agent Idle</span>
        </div>

        <button className={styles.newTask} onClick={() => navigate(ROUTES.root)}>
          <Icon name="plus" size={16} />
          <span>NEW TASK</span>
        </button>
      </div>

      {/* ── Recent Sessions ──────────────────────────────────────────────── */}
      <div className={styles.recent}>
        <div className={styles.recentHead}>Recent Sessions</div>
        <div className={styles.list}>
          {isLoading && <div className={styles.muted}>Loading…</div>}
          {!isLoading && missions.length === 0 && (
            <div className={styles.muted}>No missions yet</div>
          )}
          {missions.map((m) => {
            const statusLabel =
              WORK_ITEM_STATUS[m.status as keyof typeof WORK_ITEM_STATUS]?.label ?? m.status
            const statusColor =
              WORK_ITEM_STATUS[m.status as keyof typeof WORK_ITEM_STATUS]?.color ?? 'var(--neutral)'
            return (
              <NavLink
                key={m.id}
                to={routeTo.mission(m.id) + `?repo=${m.repo_id}`}
                className={({ isActive }) => `${styles.item} ${isActive ? styles.itemActive : ''}`}
              >
                <div className={styles.itemTop}>
                  <span className={styles.itemTitle}>{m.intent}</span>
                  <span
                    className={styles.itemBadge}
                    style={{ color: statusColor, background: statusColor.startsWith('#') ? `${statusColor}20` : 'var(--neutral-subtle)' }}
                  >
                    {statusLabel}
                  </span>
                </div>
                <p className={styles.itemDesc}>{repoName(m.repo_id)}</p>
                <span className={styles.itemTime}>2 hours ago</span>
              </NavLink>
            )
          })}
        </div>
      </div>

      {/* ── Agent Stats + Account Footer ─────────────────────────────────── */}
      <div className={styles.footer}>
        <div className={styles.stats}>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>
              CPU
            </span>
            <span className={styles.statValue}>4.2%</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>
              Ram
            </span>
            <span className={styles.statValue}>1.8 GB</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>
              Environment
            </span>
            <span className={styles.statValue} style={{ color: 'var(--accent)' }}>Sandbox Active</span>
          </div>
        </div>

        <div className={styles.accountRow}>
          <Dropdown
            align="start"
            width={220}
            header={
              <div>
                <div className={styles.userName}>{user?.name}</div>
                <div className={styles.userEmail}>{user?.email}</div>
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
              <button className={styles.accountBtn} onClick={toggle} aria-label="Account">
                <img
                  src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user?.name ?? 'U')}&backgroundColor=00FF66&textColor=050507&fontSize=40`}
                  alt={user?.name?.[0] ?? '?'}
                  className={styles.avatar}
                />
                <div className={styles.accountInfo}>
                  <span className={styles.accountName}>{user?.name ?? 'Account'}</span>
                  <span className={styles.accountEmail}>{user?.email}</span>
                </div>
              </button>
            )}
          />
          <Tooltip content={theme === 'dark' ? 'Light mode' : 'Dark mode'} side="top">
            <button
              className={styles.themeBtn}
              onClick={() => dispatch(themeToggled())}
              aria-label="Toggle theme"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
    </aside>
  )
}
