import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../Icon/Icon'
import styles from './Breadcrumb.module.css'

export interface Crumb {
  label: string
  to?: string
}

export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className={styles.root} aria-label="Breadcrumb">
      {items.map((item, i) => {
        const last = i === items.length - 1
        return (
          <Fragment key={i}>
            {item.to && !last ? (
              <Link to={item.to} className={styles.link}>
                {item.label}
              </Link>
            ) : (
              <span className={last ? styles.current : styles.link}>{item.label}</span>
            )}
            {!last && <Icon name="chevronRight" size={14} className={styles.sep} />}
          </Fragment>
        )
      })}
    </nav>
  )
}
