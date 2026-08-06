import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { THEME_KEY } from '@/constants/config'

export type Theme = 'dark' | 'light'

interface UIState {
  theme: Theme
  sidebarCollapsed: boolean
  bottomPanelOpen: boolean
  commandPaletteOpen: boolean
}

function loadTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY)
  return stored === 'dark' ? 'dark' : 'light'
}

const initialState: UIState = {
  theme: loadTheme(),
  sidebarCollapsed: false,
  bottomPanelOpen: false,
  commandPaletteOpen: false,
}

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    themeToggled(state) {
      state.theme = state.theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem(THEME_KEY, state.theme)
    },
    themeSet(state, action: PayloadAction<Theme>) {
      state.theme = action.payload
      localStorage.setItem(THEME_KEY, state.theme)
    },
    sidebarToggled(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed
    },
    bottomPanelToggled(state) {
      state.bottomPanelOpen = !state.bottomPanelOpen
    },
    commandPaletteToggled(state, action: PayloadAction<boolean | undefined>) {
      state.commandPaletteOpen = action.payload ?? !state.commandPaletteOpen
    },
  },
})

export const {
  themeToggled,
  themeSet,
  sidebarToggled,
  bottomPanelToggled,
  commandPaletteToggled,
} = uiSlice.actions
export default uiSlice.reducer
