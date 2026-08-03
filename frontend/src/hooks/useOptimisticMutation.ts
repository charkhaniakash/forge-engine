import { useCallback } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { setOptimistic } from '@/store/slices/optimisticSlice'

interface UseOptimisticMutationParams {
  taskId: string
}

/**
 * Hook to manage optimistic UI updates for mutations.
 * Shows loading state immediately while the mutation is in flight.
 *
 * Usage:
 * ```
 * const { isOptimistic, setOptimistic } = useOptimisticMutation({ taskId }, 'approving')
 * const handleClick = async () => {
 *   setOptimistic(true)
 *   try {
 *     await mutate()
 *   } finally {
 *     setOptimistic(false)
 *   }
 * }
 * ```
 */
export function useOptimisticMutation(
  { taskId }: UseOptimisticMutationParams,
  mutationName: string,
) {
  const dispatch = useAppDispatch()

  // Get current optimistic state for this mutation
  const isOptimistic = useAppSelector(
    (state) => state.optimistic.mutations[taskId]?.[mutationName] ?? false,
  )

  // Set optimistic state
  const setOptimisticState = useCallback(
    (loading: boolean) => {
      dispatch(setOptimistic({ taskId, mutation: mutationName, loading }))
    },
    [dispatch, taskId, mutationName],
  )

  return {
    isOptimistic,
    setOptimistic: setOptimisticState,
  }
}
