import { baseApi } from './baseApi'
import type { Plan, PlanBody, WorkItem, MissionMessage } from '@/types'

interface TaskDetail {
  task: WorkItem
  plan: Plan | null
}

export const taskApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    /** Recent Missions across the whole org — powers the sidebar + console. */
    listMissions: builder.query<WorkItem[], void>({
      query: () => '/missions',
      transformResponse: (res: { missions?: WorkItem[] }) => res.missions ?? [],
      providesTags: [{ type: 'Task', id: 'MISSIONS' }],
    }),

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
        { type: 'Task', id: 'MISSIONS' },
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

    /** Tier 1 follow-up: refine the current (plan_ready) plan with an extra note. */
    refinePlan: builder.mutation<
      { task: WorkItem },
      { repoId: string; taskId: string; note: string }
    >({
      query: ({ repoId, taskId, note }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/refine`,
        method: 'POST',
        body: { note },
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

    /** Mission follow-up: send a new message in the same thread to re-plan. */
    followUp: builder.mutation<
      { task: WorkItem; turn_number: number; message: MissionMessage },
      { repoId: string; taskId: string; message: string }
    >({
      query: ({ repoId, taskId, message }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/follow-up`,
        method: 'POST',
        body: { message },
      }),
      invalidatesTags: (_r, _e, { taskId }) => [
        { type: 'Task', id: taskId },
        { type: 'MissionMessages', id: taskId },
      ],
    }),

    /** Get the full mission message history for a work item. */
    listMissionMessages: builder.query<
      { messages: MissionMessage[] },
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => `/repos/${repoId}/tasks/${taskId}/messages`,
      providesTags: (_r, _e, { taskId }) => [
        { type: 'MissionMessages', id: taskId },
      ],
    }),
  }),
})

export const {
  useListMissionsQuery,
  useListTasksQuery,
  useGetTaskQuery,
  useListPlansQuery,
  useCreateTaskMutation,
  useUpdatePlanMutation,
  useApproveTaskMutation,
  useReplanTaskMutation,
  useRefinePlanMutation,
  useCancelTaskMutation,
  useFollowUpMutation,
  useListMissionMessagesQuery,
} = taskApi
