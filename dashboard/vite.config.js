import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vite proxy forwards /analytics requests to the Express server so the
 * dashboard can be developed without CORS headers on the API.
 *
 * In production, serve the built dashboard as static files from Express,
 * or deploy them to the same origin — the proxy is only needed in dev.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/analytics': {
        target:       'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
