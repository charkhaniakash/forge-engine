import type { ReactNode } from 'react'
import { Breadcrumb, type Crumb } from '../Breadcrumb/Breadcrumb'
import styles from './PageHeader.module.css'

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
    <div className={styles.root}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <div className={styles.crumbs}>
          <Breadcrumb items={breadcrumbs} />
        </div>
      )}
      <div className={styles.row}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{title}</h1>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {children && <div className={styles.extra}>{children}</div>}
    </div>
  )
}
