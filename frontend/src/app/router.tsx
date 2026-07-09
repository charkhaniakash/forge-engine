/* eslint-disable react-refresh/only-export-components */
import { lazy } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout } from '@/layouts/AppLayout/AppLayout'
import { AuthLayout } from '@/layouts/AuthLayout/AuthLayout'
import { ROUTES } from '@/constants/routes'

// Auth
const Login = lazy(() => import('@/pages/Login/Login'))
const Signup = lazy(() => import('@/pages/Signup/Signup'))
const GitHubInstallCallback = lazy(
  () => import('@/pages/GitHubInstallCallback/GitHubInstallCallback'),
)

// Core Mission-centric surfaces
const Console = lazy(() => import('@/pages/Console/Console'))
const Mission = lazy(() => import('@/pages/TaskWorkspace/TaskWorkspace'))
const AskThread = lazy(() => import('@/pages/Ask/AskThread'))
const Repositories = lazy(() => import('@/pages/Repositories/Repositories'))
const Settings = lazy(() => import('@/pages/Settings/Settings'))

export const router = createBrowserRouter([
  {
    path: ROUTES.githubCallback,
    element: <GitHubInstallCallback />,
  },
  {
    element: <AuthLayout />,
    children: [
      { path: ROUTES.login, element: <Login /> },
      { path: ROUTES.signup, element: <Signup /> },
    ],
  },
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <Console /> },
      { path: ROUTES.mission, element: <Mission /> },
      { path: ROUTES.ask, element: <AskThread /> },
      { path: ROUTES.repositories, element: <Repositories /> },
      { path: ROUTES.settings, element: <Settings /> },
      { path: '*', element: <Navigate to={ROUTES.root} replace /> },
    ],
  },
])
