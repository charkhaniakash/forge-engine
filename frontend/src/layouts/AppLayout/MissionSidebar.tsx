import { NavLink, useNavigate } from 'react-router-dom'
import { Icon, StatusBadge, Dropdown, Tooltip } from '@/components/common'
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
 * the rail is "New Mission" + the live list of recent missions, not a set of
 * CRUD destinations. Everything else (repositories, settings) is secondary.
 */
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

  return (
    <aside className={styles.sidebar}>
      <div className={styles.top}>
        <div className={styles.brand}>
          <span className={styles.logo}>◆</span>
          <span className={styles.brandName}>Forge</span>
          {org && <span className={styles.org}>{org.name}</span>}
        </div>
      </div>

      <button className={styles.newMission} onClick={() => navigate(ROUTES.root)}>
        <Icon name="plus" size={16} /> New Mission
      </button>

      <div className={styles.recent}>
        <div className={styles.recentHead}>Missions</div>
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

      <div className={styles.footer}>
        <NavLink to={ROUTES.repositories} className={styles.footerLink}>
          <Icon name="repo" size={16} /> Repositories
        </NavLink>
        <Tooltip content={theme === 'dark' ? 'Light mode' : 'Dark mode'} side="right">
          <button className={styles.footerBtn} onClick={() => dispatch(themeToggled())} aria-label="Toggle theme">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
        </Tooltip>
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
            <button className={styles.avatar} onClick={toggle} aria-label="Account">
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </button>
          )}
        />
      </div>
    </aside>
  )
}
