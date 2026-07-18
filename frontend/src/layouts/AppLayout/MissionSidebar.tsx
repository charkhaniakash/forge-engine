import { NavLink, useNavigate } from 'react-router-dom'
import { Icon, StatusBadge, Dropdown, Tooltip } from '@/components/common'
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

/**
 * The single persistent navigation surface. A Mission is the primary object:
 * the rail is "New Mission" + the live list of recent missions, plus links to
 * the few real destinations (Console, Repositories). Everything is anchored to
 * the account footer at the bottom.
 */
const NAV: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: ROUTES.root, label: 'Console', icon: 'dashboard', end: true },
  { to: ROUTES.repositories, label: 'Repositories', icon: 'repo' },
]

export function MissionSidebar() {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { user, org } = useAuth()
  const theme = useAppSelector((s) => s.ui.theme)

  const { data: missions = [], isLoading } = useListMissionsQuery(undefined, {
    pollingInterval: 15000,
  })
  const { data: repos = [] } = useListReposQuery()
  const repoName = (repoId: string) =>
    repos.find((r) => r.id === repoId)?.repo_full_name ?? 'repository'

  const activeCount = missions.filter((m) =>
    ['planning', 'draft', 'plan_ready', 'plan_approved', 'executing', 'validating', 'repairing', 'publishing'].includes(m.status),
  ).length

  return (
    <aside className={styles.sidebar}>
      {/* ── Brand ─────────────────────────────────────────────────────────── */}
      <div className={styles.top}>
        <div className={styles.brand}>
          <span className={styles.logo}>
            <Icon name="sparkles" size={18} />
          </span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>Forge</span>
            <span className={styles.brandSub}>{org?.name ?? 'Engine'}</span>
          </span>
        </div>
      </div>

      <button className={styles.newMission} onClick={() => navigate(ROUTES.root)}>
        <Icon name="plus" size={16} /> New Mission
      </button>

      {/* ── Primary nav ───────────────────────────────────────────────────── */}
      <nav className={styles.nav}>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
          >
            <Icon name={n.icon} size={16} /> {n.label}
          </NavLink>
        ))}
      </nav>

      {/* ── Recent missions ───────────────────────────────────────────────── */}
      <div className={styles.recent}>
        <div className={styles.recentHead}>
          <span>Recent Missions</span>
          {activeCount > 0 && <span className={styles.activePill}>{activeCount} active</span>}
        </div>
        <div className={styles.list}>
          {isLoading && <div className={styles.muted}>Loading…</div>}
          {!isLoading && missions.length === 0 && (
            <div className={styles.muted}>No missions yet</div>
          )}
          {missions.map((m) => (
            <NavLink
              key={m.id}
              to={routeTo.mission(m.id) + `?repo=${m.repo_id}`}
              className={({ isActive }) => `${styles.item} ${isActive ? styles.itemActive : ''}`}
            >
              <span className={styles.itemIntent}>{m.intent}</span>
              <span className={styles.itemMeta}>
                <StatusBadge map={WORK_ITEM_STATUS} status={m.status} size="sm" dot />
                <span className={styles.itemRepo}>{repoName(m.repo_id)}</span>
              </span>
            </NavLink>
          ))}
        </div>
      </div>

      {/* ── Account footer ────────────────────────────────────────────────── */}
      <div className={styles.footer}>
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
            { id: 'settings', label: 'Settings', icon: <Icon name="settings" size={14} />, onSelect: () => navigate(ROUTES.settings) },
            { id: 'logout', label: 'Log out', icon: <Icon name="logout" size={14} />, danger: true, divider: true, onSelect: () => { dispatch(loggedOut()); navigate(ROUTES.login) } },
          ]}
          trigger={({ toggle }) => (
            <button className={styles.account} onClick={toggle} aria-label="Account">
              <span className={styles.avatar}>{user?.name?.[0]?.toUpperCase() ?? '?'}</span>
              <span className={styles.accountText}>
                <span className={styles.accountName}>{user?.name ?? 'Account'}</span>
                <span className={styles.accountEmail}>{user?.email}</span>
              </span>
            </button>
          )}
        />
        <Tooltip content={theme === 'dark' ? 'Light mode' : 'Dark mode'} side="top">
          <button className={styles.footerBtn} onClick={() => dispatch(themeToggled())} aria-label="Toggle theme">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
        </Tooltip>
      </div>
    </aside>
  )
}
