import { baseApi } from './baseApi'
import type { RepairSession } from '@/types/repair'

/**
 * Repair session REST endpoints. Injected into the shared baseApi so there is
 * one reducer + one middleware in the store (same pattern as all other domain
 * APIs).
 */
export const repairApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getRepairSessionByTask: builder.query<RepairSession, string>({
      query: (taskExecutionId) =>
        `/repair/sessions/by-task/${taskExecutionId}`,
      providesTags: (_r, _e, taskId) => [
        { type: 'Repair', id: taskId },
        { type: 'Execution', id: taskId },
      ],
    }),
  }),
})

export const { useGetRepairSessionByTaskQuery } = repairApi
