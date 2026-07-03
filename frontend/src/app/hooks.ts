import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from './store'

/** Typed `useDispatch` — use everywhere instead of the untyped default. */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()

/** Typed `useSelector`. */
export const useAppSelector = useSelector.withTypes<RootState>()
