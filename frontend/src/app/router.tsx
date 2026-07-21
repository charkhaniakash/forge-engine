/* eslint-disable react-refresh/only-export-components */
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout } from '@/layouts/AppLayout/AppLayout'
import { AuthLayout } from '@/layouts/AuthLayout/AuthLayout'
import { ROUTES } from '@/constants/routes'
import GitHubInstallCallback from '@/pages/GitHubInstallCallback/GitHubInstallCallback'
import Login from '@/pages/Login/Login'
import Signup from '@/pages/Signup/Signup'
import Console from '@/pages/Console/Console'
import TaskWorkspace from '@/pages/TaskWorkspace/TaskWorkspace'
import AskThread from '@/pages/Ask/AskThread'
import Repositories from '@/pages/Repositories/Repositories'
import Settings from '@/pages/Settings/Settings'
import Workspace from '@/pages/Workspace/Workspace'

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
      { path: ROUTES.mission, element: <TaskWorkspace /> },
      { path: ROUTES.ask, element: <AskThread /> },
      { path: ROUTES.repositories, element: <Repositories /> },
      { path: ROUTES.settings, element: <Settings /> },
      { path: ROUTES.workspaceEditor, element: <Workspace /> },
      { path: '*', element: <Navigate to={ROUTES.root} replace /> },
    ],
  },
])
