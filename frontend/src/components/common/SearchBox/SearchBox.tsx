import { forwardRef, type InputHTMLAttributes } from 'react'
import { Icon } from '../Icon/Icon'
import styles from './SearchBox.module.css'

export interface SearchBoxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md'
  /** Optional trailing keyboard hint, e.g. "⌘K". */
  shortcut?: string
}

export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(
  function SearchBox({ size = 'md', shortcut, className, ...rest }, ref) {
    return (
      <div className={`${styles.root} ${styles[size]} ${className ?? ''}`}>
        <Icon name="search" size={size === 'sm' ? 14 : 16} className={styles.icon} />
        <input ref={ref} className={styles.input} type="search" {...rest} />
        {shortcut && <kbd className={styles.kbd}>{shortcut}</kbd>}
      </div>
    )
  },
)
