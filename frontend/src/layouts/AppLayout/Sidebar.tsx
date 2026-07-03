import { NavLink } from 'react-router-dom'
import { Icon, type IconName, Tooltip } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { sidebarToggled } from '@/store/slices/uiSlice'
import { ROUTES } from '@/constants/routes'
import styles from './Sidebar.module.css'

interface NavItem {
  to: string
  label: string
  icon: IconName
  /** Future phase — rendered disabled with a "Soon" hint. */
  soon?: boolean
}

interface NavSection {
  heading?: string
  items: NavItem[]
}

const SECTIONS: NavSection[] = [
  {
    items: [
      { to: ROUTES.dashboard, label: 'Dashboard', icon: 'dashboard' },
      { to: ROUTES.repositories, label: 'Repositories', icon: 'repo' },
      { to: ROUTES.tasks, label: 'Tasks', icon: 'task' },
      { to: ROUTES.organizations, label: 'Organizations', icon: 'org' },
    ],
  },
  {
    heading: 'Coming soon',
    items: [
      { to: ROUTES.buildTest, label: 'Build & Test', icon: 'build', soon: true },
      { to: ROUTES.repairs, label: 'Repairs', icon: 'repair', soon: true },
      { to: ROUTES.git, label: 'Git', icon: 'git', soon: true },
      { to: ROUTES.workspace, label: 'Workspace', icon: 'workspace', soon: true },
      { to: ROUTES.audit, label: 'Audit', icon: 'audit', soon: true },
      { to: ROUTES.usage, label: 'Usage', icon: 'usage', soon: true },
    ],
  },
]

export function Sidebar() {
  const collapsed = useAppSelector((s) => s.ui.sidebarCollapsed)
  const dispatch = useAppDispatch()

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <nav className={styles.nav}>
        {SECTIONS.map((section, i) => (
          <div key={i} className={styles.section}>
            {section.heading && !collapsed && (
              <div className={styles.heading}>{section.heading}</div>
            )}
            {section.items.map((item) => (
              <NavItemLink key={item.to} item={item} collapsed={collapsed} />
            ))}
          </div>
        ))}
      </nav>

      <button
        className={styles.collapseBtn}
        onClick={() => dispatch(sidebarToggled())}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
        {!collapsed && <span>Collapse</span>}
      </button>
    </aside>
  )
}

function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const content = (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        `${styles.link} ${isActive && !item.soon ? styles.active : ''} ${
          item.soon ? styles.soon : ''
        }`
      }
      onClick={item.soon ? (e) => e.preventDefault() : undefined}
      aria-disabled={item.soon}
    >
      <Icon name={item.icon} size={18} className={styles.icon} />
      {!collapsed && <span className={styles.label}>{item.label}</span>}
      {!collapsed && item.soon && <span className={styles.soonTag}>Soon</span>}
    </NavLink>
  )
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {content}
    </Tooltip>
  ) : (
    content
  )
}
