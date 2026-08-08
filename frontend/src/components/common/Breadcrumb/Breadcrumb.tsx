import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../Icon/Icon'

export interface Crumb {
  label: string
  to?: string
}

export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className="flex items-center gap-1 text-sm" aria-label="Breadcrumb">
      {items.map((item, i) => {
        const last = i === items.length - 1
        return (
          <Fragment key={i}>
            {item.to && !last ? (
              <Link
                to={item.to}
                className="text-fg-muted no-underline transition-colors duration-150 hover:text-fg hover:no-underline"
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={
                  last ? 'font-medium text-fg' : 'text-fg-muted no-underline'
                }
              >
                {item.label}
              </span>
            )}
            {!last && (
              <Icon
                name="chevronRight"
                size={14}
                className="flex-shrink-0 text-fg-subtle"
              />
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
