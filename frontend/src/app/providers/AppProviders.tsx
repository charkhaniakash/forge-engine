import { Provider } from 'react-redux'
import { RouterProvider } from 'react-router-dom'
import { store } from '@/app/store'
import { router } from '@/app/router'
import { ThemeSync } from './ThemeSync'
import { ToastViewport } from '@/components/common'

/** Root providers: Redux store, theme sync, router, and global toasts. */
export function AppProviders() {
  return (
    <Provider store={store}>
      <ThemeSync />
      <RouterProvider router={router} />
      <ToastViewport />
    </Provider>
  )
}
