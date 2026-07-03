import { useNavigate } from 'react-router-dom'
import {
  Badge,
  Button,
  Dropdown,
  Icon,
  SearchBox,
  Tooltip,
} from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { themeToggled } from '@/store/slices/uiSlice'
import { loggedOut, activeOrgChanged } from '@/store/slices/authSlice'
import { allNotificationsRead } from '@/store/slices/notificationSlice'
import { useAuth } from '@/hooks/useAuth'
import { useListOrgsQuery } from '@/services/api/organizationApi'
import { ROUTES } from '@/constants/routes'
import styles from './TopNav.module.css'

export function TopNav() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { user, org, role } = useAuth()
  const theme = useAppSelector((s) => s.ui.theme)
  const notifications = useAppSelector((s) => s.notifications.notifications)
  const activeExecutions = useAppSelector((s) =>
    Object.values(s.stream.execution).filter((e) => !e.complete && e.events.length > 0),
  )
  const unread = notifications.filter((n) => !n.read).length

  const { data: orgs = [] } = useListOrgsQuery()

  return (
    <header className={styles.topnav}>
      <div className={styles.left}>
        <div className={styles.brand} onClick={() => navigate(ROUTES.dashboard)}>
          <span className={styles.logo}>◆</span>
          <span className={styles.brandName}>Forge</span>
        </div>

        <span className={styles.divider} />

        <Dropdown
          align="start"
          width={240}
          header="Organizations"
          items={orgs.map((o) => ({
            id: o.id,
            label: o.name,
            icon: <Icon name="org" size={14} />,
            onSelect: () => dispatch(activeOrgChanged(o)),
          }))}
          trigger={({ toggle }) => (
            <button className={styles.orgSwitcher} onClick={toggle}>
              <Icon name="org" size={15} />
              <span className={styles.orgName}>{org?.name ?? 'No org'}</span>
              <Icon name="chevronDown" size={14} />
            </button>
          )}
        />
      </div>

      <div className={styles.center}>
        <SearchBox
          size="sm"
          placeholder="Search repositories, tasks…"
          shortcut="⌘K"
          className={styles.search}
        />
      </div>

      <div className={styles.right}>
        {activeExecutions.length > 0 && (
          <Tooltip content={`${activeExecutions.length} active execution(s)`}>
            <button className={styles.execIndicator} onClick={() => navigate(ROUTES.tasks)}>
              <span className={styles.execDot} />
              <span>{activeExecutions.length} running</span>
            </button>
          </Tooltip>
        )}

        <Tooltip content={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => dispatch(themeToggled())}
            aria-label="Toggle theme"
            leadingIcon={<Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />}
          />
        </Tooltip>

        <Dropdown
          width={300}
          header={
            <div className={styles.notifHeader}>
              <span>Notifications</span>
              {unread > 0 && (
                <button
                  className={styles.markRead}
                  onClick={() => dispatch(allNotificationsRead())}
                >
                  Mark all read
                </button>
              )}
            </div>
          }
          items={
            notifications.length === 0
              ? [{ id: 'empty', label: 'No notifications', disabled: true }]
              : notifications.slice(0, 8).map((n) => ({
                  id: n.id,
                  label: (
                    <span className={n.read ? styles.readNotif : styles.unreadNotif}>
                      {n.title}
                    </span>
                  ),
                  onSelect: n.href ? () => navigate(n.href!) : undefined,
                }))
          }
          trigger={({ toggle }) => (
            <button className={styles.iconBtn} onClick={toggle} aria-label="Notifications">
              <Icon name="bell" size={17} />
              {unread > 0 && <span className={styles.badge}>{unread}</span>}
            </button>
          )}
        />

        <Dropdown
          width={220}
          header={
            <div className={styles.userHeader}>
              <div className={styles.userName}>{user?.name}</div>
              <div className={styles.userEmail}>{user?.email}</div>
              {role && (
                <div style={{ marginTop: 4 }}>
                  <Badge tone="accent" size="sm">
                    {role}
                  </Badge>
                </div>
              )}
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
            <button className={styles.avatar} onClick={toggle} aria-label="Account">
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </button>
          )}
        />
      </div>
    </header>
  )
}
