import type { ReactNode } from 'react'
import { Breadcrumb, type Crumb } from '../Breadcrumb/Breadcrumb'

export interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  breadcrumbs?: Crumb[]
  actions?: ReactNode
  /** Optional tabs/filter row rendered under the title. */
  children?: ReactNode
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  children,
}: PageHeaderProps) {
  return (
    <div className="px-8 py-6 border-b border-line-subtle">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <div className="mb-3">
          <Breadcrumb items={breadcrumbs} />
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-fg leading-tight">{title}</h1>
          {description && (
            <p className="mt-2 max-w-[720px] text-base text-fg-muted">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </div>
  )
}
