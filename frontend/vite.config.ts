import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Backend origin used for the dev proxy. Overridable via VITE_BACKEND_URL.
const BACKEND = process.env.VITE_BACKEND_URL ?? 'http://localhost:8080'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // REST + WebSocket both live under /v1 on the Go backend.
      '/v1': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
