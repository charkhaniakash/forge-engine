import { Icon } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { themeSet, type Theme } from '@/store/slices/uiSlice'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

const THEMES: { value: Theme; label: string; icon: 'moon' | 'sun' }[] = [
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
]

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden border-border bg-card py-0">
      <div className="border-b border-line-subtle px-4 py-3">
        <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
      </div>
      {children}
    </Card>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line-subtle px-4 py-3 last:border-b-0">
      <span className="text-[13px] text-fg-subtle">{label}</span>
      <span className="text-[13px] text-fg">{value}</span>
    </div>
  )
}

export function Settings() {
  const { user, org, role } = useAuth()
  const theme = useAppSelector((s) => s.ui.theme)
  const dispatch = useAppDispatch()

  return (
    <div className="flex h-full flex-col overflow-hidden bg-base">
      <header className="flex-shrink-0 border-b border-line px-6 py-5">
        <h1 className="text-lg font-semibold text-fg">Settings</h1>
        <p className="mt-1 text-[13px] text-fg-muted">Manage your profile and preferences.</p>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
          <SettingsCard title="Profile">
            <Row label="Name" value={user?.name ?? '—'} />
            <Row label="Email" value={user?.email ?? '—'} />
            <Row label="Role" value={role ? <Badge variant="outline" className="border-primary/30 font-normal text-primary">{role}</Badge> : '—'} />
          </SettingsCard>

          <SettingsCard title="Organization">
            <Row label="Name" value={org?.name ?? '—'} />
            <Row label="ID" value={<span className="font-mono text-xs">{org?.id ?? '—'}</span>} />
          </SettingsCard>

          <SettingsCard title="Appearance">
            <div className="flex gap-3 p-4">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  className={cn(
                    'relative flex flex-1 flex-col items-center gap-2 rounded-xl border p-4 transition-all cursor-pointer',
                    theme === t.value
                      ? 'border-primary/40 bg-primary/5 text-fg'
                      : 'border-border text-fg-muted hover:border-line-strong hover:bg-surface-2',
                  )}
                  onClick={() => dispatch(themeSet(t.value))}
                >
                  <Icon name={t.icon} size={20} />
                  <span className="text-[13px] font-medium">{t.label}</span>
                  {theme === t.value && (
                    <span className="absolute right-2 top-2 text-primary">
                      <Icon name="check" size={15} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </SettingsCard>

          <SettingsCard title="About">
            <Row label="Product" value="Forge Engine" />
            <Row label="Current phase" value={<Badge variant="outline" className="border-primary/30 font-normal text-primary">Phase 7 · Autonomous Execution</Badge>} />
          </SettingsCard>
        </div>
      </div>
    </div>
  )
}

export default Settings
