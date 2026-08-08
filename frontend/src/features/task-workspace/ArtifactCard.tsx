import type { ReactNode } from 'react'
import { Accordion, Icon } from '@/components/common'
import type { IconName } from '@/components/common'
import { cn } from '@/lib/utils'

export interface ArtifactCardProps {
  icon: IconName
  title: ReactNode
  subtitle?: ReactNode
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
  /** Open behind the collapsed summary — reserve for what still needs attention or just finished. */
  defaultOpen?: boolean
  right?: ReactNode
  children: ReactNode
}

const TONE_BORDER: Record<string, string> = {
  neutral: 'border-line',
  success: 'border-success/30',
  warning: 'border-warning/30',
  danger: 'border-destructive/30',
}

/**
 * The one shared "artifact" shell for plan/files/validation/repair/publish
 * entries in the Mission thread — a compact collapsed summary line by default,
 * with the full detail tucked behind it.
 */
export function ArtifactCard({ icon, title, subtitle, tone = 'neutral', defaultOpen = false, right, children }: ArtifactCardProps) {
  return (
    <Accordion
      className={cn('overflow-hidden rounded-lg border bg-card', TONE_BORDER[tone] ?? TONE_BORDER.neutral)}
      defaultOpen={defaultOpen}
      right={right}
      title={
        <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
          <Icon name={icon} size={15} className="text-fg-subtle" /> {title}
        </span>
      }
      subtitle={subtitle}
    >
      {children}
    </Accordion>
  )
}
