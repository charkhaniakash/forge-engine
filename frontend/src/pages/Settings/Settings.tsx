import {
  Badge,
  Card,
  CardHeader,
  Icon,
  PageHeader,
} from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { themeSet, type Theme } from '@/store/slices/uiSlice'
import { useAuth } from '@/hooks/useAuth'
import styles from './Settings.module.css'

const THEMES: { value: Theme; label: string; icon: 'moon' | 'sun' }[] = [
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
]

export function Settings() {
  const { user, org, role } = useAuth()
  const theme = useAppSelector((s) => s.ui.theme)
  const dispatch = useAppDispatch()

  return (
    <div>
      <PageHeader title="Settings" description="Manage your profile and preferences." />
      <div className={styles.body}>
        <Card padded={false}>
          <CardHeader title="Profile" />
          <div className={styles.rows}>
            <Row label="Name" value={user?.name ?? '—'} />
            <Row label="Email" value={user?.email ?? '—'} />
            <Row label="Role" value={role ? <Badge tone="accent" size="sm">{role}</Badge> : '—'} />
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title="Organization" />
          <div className={styles.rows}>
            <Row label="Name" value={org?.name ?? '—'} />
            <Row label="ID" value={<span className={styles.mono}>{org?.id ?? '—'}</span>} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Appearance" />
          <div className={styles.themes}>
            {THEMES.map((t) => (
              <button
                key={t.value}
                className={`${styles.themeTile} ${theme === t.value ? styles.themeActive : ''}`}
                onClick={() => dispatch(themeSet(t.value))}
              >
                <Icon name={t.icon} size={20} />
                <span>{t.label}</span>
                {theme === t.value && <Icon name="check" size={15} className={styles.themeCheck} />}
              </button>
            ))}
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title="About" />
          <div className={styles.rows}>
            <Row label="Product" value="Forge Engine" />
            <Row label="Current phase" value={<Badge tone="accent" size="sm">Phase 7 · Autonomous Execution</Badge>} />
          </div>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  )
}

export default Settings
