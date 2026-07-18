/**
 * Centralised route paths. Use the builder functions for parameterised routes
 * so link generation stays in one place.
 */

export const ROUTES = {
  root: '/',
  login: '/login',
  signup: '/signup',
  githubCallback: '/github/install/callback',

  dashboard: '/dashboard',

  repositories: '/repositories',
  repository: '/repositories/:id',
  repositoryQA: '/repositories/:id/qa',

  tasks: '/tasks',
  mission: '/mission/:id',
  ask: '/ask/:id',
  task: '/tasks/:id',
  taskPlan: '/tasks/:id/plan',
  taskExecution: '/tasks/:id/execution',
  taskWorkspace: '/tasks/:id/workspace',
  taskValidation: '/tasks/:id/validation',

  organizations: '/organizations',
  settings: '/settings',

  // Future-phase placeholders (Phases 8–13).
  buildTest: '/build-test',
  repairs: '/repairs',
  git: '/git',
  workspace: '/workspace',
  workspaceEditor: '/workspace/:workspaceId',
  audit: '/audit',
  usage: '/usage',
} as const

export const routeTo = {
  repository: (id: string) => `/repositories/${id}`,
  repositoryQA: (id: string) => `/repositories/${id}/qa`,
  mission: (id: string) => `/mission/${id}`,
  ask: (id: string) => `/ask/${id}`,
  task: (id: string) => `/tasks/${id}`,
  taskPlan: (id: string) => `/tasks/${id}/plan`,
  taskExecution: (id: string) => `/tasks/${id}/execution`,
  taskWorkspace: (id: string) => `/tasks/${id}/workspace`,
  taskValidation: (id: string) => `/tasks/${id}/validation`,
  workspaceEditor: (workspaceId: string, taskId?: string, repoId?: string) => {
    const qs = new URLSearchParams()
    if (taskId) qs.set('task', taskId)
    if (repoId) qs.set('repo', repoId)
    const suffix = qs.toString()
    return `/workspace/${workspaceId}${suffix ? `?${suffix}` : ''}`
  },
}
