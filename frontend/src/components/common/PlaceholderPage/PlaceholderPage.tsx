import type { ReactNode } from 'react'
import { PageHeader } from '../PageHeader/PageHeader'
import { EmptyState } from '../EmptyState/EmptyState'
import { Badge } from '../Badge/Badge'
import { Icon, type IconName } from '../Icon/Icon'

export interface PlaceholderPageProps {
  title: string
  phase: string
  icon: IconName
  description: ReactNode
  /** Feature bullets shown as an at-a-glance preview of the phase. */
  features?: string[]
}

/**
 * Reusable "coming in a future phase" page. Every future-phase route renders
 * one of these so navigation is complete before the backend lands.
 */
export function PlaceholderPage({
  title,
  phase,
  icon,
  description,
  features,
}: PlaceholderPageProps) {
  return (
    <div>
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
            {title}
            <Badge tone="accent" size="sm">
              {phase}
            </Badge>
          </span>
        }
        description={description}
      />
      <div style={{ padding: 'var(--space-8)' }}>
        <EmptyState
          icon={<Icon name={icon} size={40} />}
          title={`${title} is coming soon`}
          description={
            features && features.length > 0 ? (
              <ul
                style={{
                  textAlign: 'left',
                  margin: '16px auto 0',
                  maxWidth: 420,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.9,
                }}
              >
                {features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              'This surface is wired into the app shell and will activate when its backend phase ships.'
            )
          }
        />
      </div>
    </div>
  )
}
