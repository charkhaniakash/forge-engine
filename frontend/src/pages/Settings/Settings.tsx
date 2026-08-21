import { useEffect, useMemo, useState } from 'react'
import { Icon, Spinner } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { themeSet, type Theme } from '@/store/slices/uiSlice'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import {
  useActivateLLMProviderMutation,
  useDeleteLLMCredentialMutation,
  useGetLLMConfigQuery,
  useListLLMProvidersQuery,
  useSaveLLMCredentialMutation,
  type LLMProvider,
} from '@/services/api/llmApi'
import { cn } from '@/lib/utils'

const THEMES: { value: Theme; label: string; icon: 'moon' | 'sun' }[] = [
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
]

function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden border-border bg-card py-0">
      <div className="border-b border-line-subtle px-4 py-3">
        <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-[12px] text-fg-subtle">{description}</p>}
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

function LLMSettingsPanel() {
  const toast = useToast()
  const { data: providersData, isLoading: loadingProviders } = useListLLMProvidersQuery()
  const { data: config, isLoading: loadingConfig } = useGetLLMConfigQuery()
  const [saveCred, { isLoading: saving }] = useSaveLLMCredentialMutation()
  const [activate, { isLoading: activating }] = useActivateLLMProviderMutation()
  const [removeCred, { isLoading: removing }] = useDeleteLLMCredentialMutation()

  const providers = providersData?.providers ?? []
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)

  const selected: LLMProvider | undefined = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId],
  )

  useEffect(() => {
    if (!providers.length) return
    const active = config?.active
    const initial = active?.provider ?? providers[0].id
    setProviderId((prev) => prev || initial)
  }, [providers, config?.active])

  useEffect(() => {
    if (!selected) return
    const saved = config?.saved?.find((c) => c.provider === selected.id)
    setModel(saved?.model || selected.default_model)
    setApiKey('')
  }, [selected?.id, config?.saved])

  async function handleValidateAndSave() {
    if (!selected) return
    if (selected.requires_key && !apiKey.trim()) {
      const existing = config?.saved?.find((c) => c.provider === selected.id)
      if (!existing) {
        toast.warning('Enter an API key to validate')
        return
      }
    }
    try {
      const result = await saveCred({
        provider: selected.id,
        model: model.trim() || selected.default_model,
        api_key: apiKey.trim(),
        activate: true,
      }).unwrap()
      toast.success(result.message || 'Provider validated and saved')
      setApiKey('')
    } catch (err: unknown) {
      const msg =
        typeof err === 'object' && err && 'data' in err
          ? String((err as { data?: { error?: string } }).data?.error ?? 'Validation failed')
          : 'Validation failed'
      toast.error(msg)
    }
  }

  async function handleActivate(id: string) {
    try {
      await activate(id).unwrap()
      toast.success('Provider activated')
    } catch {
      toast.error('Could not activate provider')
    }
  }

  async function handleDelete(id: string) {
    try {
      await removeCred(id).unwrap()
      toast.success('Provider removed')
      if (providerId === id) setApiKey('')
    } catch {
      toast.error('Could not remove provider')
    }
  }

  if (loadingProviders || loadingConfig) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-10 text-fg-subtle">
        <Spinner size={16} /> Loading models…
      </div>
    )
  }

  const savedForSelected = config?.saved?.find((c) => c.provider === providerId)

  return (
    <div className="flex flex-col gap-4 p-4">
      {!config?.configured && (
        <div className="rounded-lg border border-warning/25 bg-warning/8 px-3.5 py-2.5 text-[13px] text-fg-muted">
          Forge does not provide an LLM. Add your own API key below, validate it, then missions and Ask will use it.
        </div>
      )}

      {config?.active && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3.5 py-2.5 text-[13px]">
          <Icon name="check" size={14} className="text-primary" />
          <span className="text-fg-muted">Active:</span>
          <span className="font-medium text-fg">{config.active.provider}</span>
          <span className="font-mono text-[12px] text-fg-subtle">{config.active.model}</span>
          {config.active.key_hint && (
            <span className="font-mono text-[11px] text-fg-subtle">{config.active.key_hint}</span>
          )}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {providers.map((p) => {
          const saved = config?.saved?.find((c) => c.provider === p.id)
          const isSelected = providerId === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setProviderId(p.id)}
              className={cn(
                'flex cursor-pointer flex-col gap-1 rounded-xl border p-3.5 text-left transition-all',
                isSelected
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border hover:border-line-strong hover:bg-surface-2',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-fg">{p.name}</span>
                {saved?.is_active && (
                  <Badge variant="outline" className="border-primary/30 font-normal text-primary">
                    Active
                  </Badge>
                )}
                {saved && !saved.is_active && (
                  <Badge variant="outline" className="font-normal text-fg-subtle">
                    Saved
                  </Badge>
                )}
              </div>
              <span className="font-mono text-[11px] text-fg-subtle">{p.default_model}</span>
              {!p.requires_key && (
                <span className="text-[11px] text-fg-subtle">No API key required</span>
              )}
            </button>
          )
        })}
      </div>

      {selected && (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2/40 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-fg">{selected.name}</h3>
            <a
              href={selected.docs_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
            >
              Get API key <Icon name="externalLink" size={12} />
            </a>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="llm-model">Model</Label>
            <Input
              id="llm-model"
              list={`models-${selected.id}`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={selected.default_model}
              className="font-mono text-[13px]"
            />
            <datalist id={`models-${selected.id}`}>
              {selected.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>

          {selected.requires_key && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="llm-key">
                API key
                {savedForSelected?.key_hint && (
                  <span className="ml-2 font-normal text-fg-subtle">
                    stored {savedForSelected.key_hint}
                  </span>
                )}
              </Label>
              <div className="relative">
                <Input
                  id="llm-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={savedForSelected ? 'Leave blank to keep existing key' : selected.hint}
                  className="pr-10 font-mono text-[13px]"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-[11px] font-medium text-fg-subtle hover:text-fg"
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={handleValidateAndSave} disabled={saving || activating}>
              {saving ? <Spinner size={14} /> : null}
              {saving ? 'Validating…' : 'Validate & save'}
            </Button>
            {savedForSelected && !savedForSelected.is_active && (
              <Button variant="outline" disabled={activating} onClick={() => handleActivate(selected.id)}>
                Set active
              </Button>
            )}
            {savedForSelected && (
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={removing}
                onClick={() => handleDelete(selected.id)}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
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
        <p className="mt-1 text-[13px] text-fg-muted">Profile, models, and preferences.</p>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
          <SettingsCard
            title="Models & API keys"
            description="Bring your own provider. Keys are encrypted at rest and never shown again after save."
          >
            <LLMSettingsPanel />
          </SettingsCard>

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
            <Row label="LLM" value="Bring your own key" />
          </SettingsCard>
        </div>
      </div>
    </div>
  )
}

export default Settings
