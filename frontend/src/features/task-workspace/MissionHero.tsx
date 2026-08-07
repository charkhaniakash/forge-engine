import { Icon } from '@/components/common'
import type { IconName } from '@/components/common'
import { cn } from '@/lib/utils'

export type HeroTone = 'active' | 'success' | 'danger' | 'neutral'

export interface MissionHeroProps {
  /** Big line — what the agent is doing right now, or the terminal outcome. */
  title: string
  /** Supporting line under the title. */
  subtitle?: string
  /** 0..1 pipeline progress. */
  progress: number
  /** Pulsing dot while a phase is streaming. */
  live?: boolean
  tone?: HeroTone
  /** Small icon. */
  icon?: IconName
  /** Right-aligned meta chips (status badge, PR link…). */
  right?: React.ReactNode
}

const TONE_RING: Record<HeroTone, string> = {
  active: 'border-primary/30',
  success: 'border-success/30',
  danger: 'border-destructive/30',
  neutral: 'border-border',
}

const TONE_AVATAR: Record<HeroTone, string> = {
  active: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  danger: 'bg-destructive/10 text-destructive',
  neutral: 'bg-muted text-fg-subtle',
}

const TONE_FILL: Record<HeroTone, string> = {
  active: 'bg-primary',
  success: 'bg-success',
  danger: 'bg-destructive',
  neutral: 'bg-fg-subtle',
}

/**
 * Devin-style spec card: a clean, minimal card at the top showing the current
 * task and status. All text is passed in from the workspace — no logic here.
 */
export function MissionHero({ title, subtitle, progress, live = false, tone = 'neutral', icon = 'sparkles', right }: MissionHeroProps) {
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm', TONE_RING[tone])}>
      <div className={cn('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg', TONE_AVATAR[tone])}>
        <Icon name={icon} size={16} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {live && (
            <span className="relative flex h-2 w-2 flex-shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          )}
          <span className="truncate text-[15px] font-semibold text-fg">{title}</span>
        </div>
        {subtitle && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-fg-muted">{subtitle}</p>}
        {progress > 0 && progress < 1 && (
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all duration-500', TONE_FILL[tone])}
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
      </div>

      {right && <div className="flex flex-shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}
