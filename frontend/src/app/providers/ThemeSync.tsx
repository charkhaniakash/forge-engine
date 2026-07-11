import { useEffect } from 'react'
import { useAppSelector } from '@/app/hooks'

/** Reflects the Redux theme onto <html data-theme> so tokens.css can switch. */
export function ThemeSync() {
  const theme = useAppSelector((s) => s.ui.theme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
  return null
}
