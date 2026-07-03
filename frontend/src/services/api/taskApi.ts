import { baseApi } from './baseApi'
import type { Plan, PlanBody, WorkItem } from '@/types'

interface TaskDetail {
  task: WorkItem
  plan: Plan | null
}

export const taskApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listTasks: builder.query<WorkItem[], string>({
      query: (repoId) => `/repos/${repoId}/tasks`,
      transformResponse: (res: { tasks?: WorkItem[] }) => res.tasks ?? [],
      providesTags: (result, _e, repoId) =>
        result
          ? [
              ...result.map((t) => ({ type: 'Task' as const, id: t.id })),
              { type: 'Task' as const, id: `LIST-${repoId}` },
            ]
          : [{ type: 'Task' as const, id: `LIST-${repoId}` }],
    }),

    getTask: builder.query<TaskDetail, { repoId: string; taskId: string }>({
      query: ({ repoId, taskId }) => `/repos/${repoId}/tasks/${taskId}`,
      transformResponse: (res: { task: WorkItem; plan: Plan | null }) => ({
        task: res.task,
        plan: res.plan ?? null,
      }),
      providesTags: (_r, _e, { taskId }) => [
        { type: 'Task', id: taskId },
        { type: 'Plan', id: taskId },
      ],
    }),

    listPlans: builder.query<Plan[], { repoId: string; taskId: string }>({
      query: ({ repoId, taskId }) => `/repos/${repoId}/tasks/${taskId}/plans`,
      transformResponse: (res: { plans?: Plan[] }) => res.plans ?? [],
      providesTags: (_r, _e, { taskId }) => [{ type: 'Plan', id: taskId }],
    }),

    createTask: builder.mutation<
      WorkItem,
      { repoId: string; intent: string; planner_hint?: string }
    >({
      query: ({ repoId, ...body }) => ({
        url: `/repos/${repoId}/tasks`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { repoId }) => [
        { type: 'Task', id: `LIST-${repoId}` },
      ],
    }),

    updatePlan: builder.mutation<
      { plan: Plan },
      { repoId: string; taskId: string; body: PlanBody }
    >({
      query: ({ repoId, taskId, body }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/plan`,
        method: 'PUT',
        body: { body },
      }),
      invalidatesTags: (_r, _e, { taskId }) => [{ type: 'Plan', id: taskId }],
    }),

    approveTask: builder.mutation<
      { task: WorkItem },
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/approve`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, { taskId }) => [{ type: 'Task', id: taskId }],
    }),

    replanTask: builder.mutation<
      { task: WorkItem },
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/replan`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, { taskId }) => [
        { type: 'Task', id: taskId },
        { type: 'Plan', id: taskId },
      ],
    }),

    cancelTask: builder.mutation<
      { status: string },
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/cancel`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, { taskId }) => [{ type: 'Task', id: taskId }],
    }),
  }),
})

export const {
  useListTasksQuery,
  useGetTaskQuery,
  useListPlansQuery,
  useCreateTaskMutation,
  useUpdatePlanMutation,
  useApproveTaskMutation,
  useReplanTaskMutation,
  useCancelTaskMutation,
} = taskApi
