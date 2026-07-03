/* eslint-disable react-refresh/only-export-components */
import { lazy } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout } from '@/layouts/AppLayout/AppLayout'
import { AuthLayout } from '@/layouts/AuthLayout/AuthLayout'
import { ROUTES } from '@/constants/routes'
import {
  Audit,
  BuildTest,
  Git,
  NotFound,
  Repairs,
  Usage,
  WorkspacePlaceholder,
} from '@/pages/placeholders'

// Route-level code splitting for the primary feature pages.
const Login = lazy(() => import('@/pages/Login/Login'))
const Signup = lazy(() => import('@/pages/Signup/Signup'))
const GitHubInstallCallback = lazy(
  () => import('@/pages/GitHubInstallCallback/GitHubInstallCallback'),
)
const Dashboard = lazy(() => import('@/pages/Dashboard/Dashboard'))
const Repositories = lazy(() => import('@/pages/Repositories/Repositories'))
const Repository = lazy(() => import('@/pages/Repository/Repository'))
const RepositoryQA = lazy(() => import('@/pages/RepositoryQA/RepositoryQA'))
const Tasks = lazy(() => import('@/pages/Tasks/Tasks'))
const Task = lazy(() => import('@/pages/Task/Task'))
const PlanReview = lazy(() => import('@/pages/PlanReview/PlanReview'))
const Execution = lazy(() => import('@/pages/Execution/Execution'))
const Workspace = lazy(() => import('@/pages/Workspace/Workspace'))
const Organizations = lazy(() => import('@/pages/Organizations/Organizations'))
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
      { index: true, element: <Navigate to={ROUTES.dashboard} replace /> },
      { path: ROUTES.dashboard, element: <Dashboard /> },
      { path: ROUTES.repositories, element: <Repositories /> },
      { path: ROUTES.repository, element: <Repository /> },
      { path: ROUTES.repositoryQA, element: <RepositoryQA /> },
      { path: ROUTES.tasks, element: <Tasks /> },
      { path: ROUTES.task, element: <Task /> },
      { path: ROUTES.taskPlan, element: <PlanReview /> },
      { path: ROUTES.taskExecution, element: <Execution /> },
      { path: ROUTES.taskWorkspace, element: <Workspace /> },
      { path: ROUTES.organizations, element: <Organizations /> },
      { path: ROUTES.settings, element: <Settings /> },
      // Future-phase placeholders.
      { path: ROUTES.buildTest, element: <BuildTest /> },
      { path: ROUTES.repairs, element: <Repairs /> },
      { path: ROUTES.git, element: <Git /> },
      { path: ROUTES.workspace, element: <WorkspacePlaceholder /> },
      { path: ROUTES.audit, element: <Audit /> },
      { path: ROUTES.usage, element: <Usage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])
