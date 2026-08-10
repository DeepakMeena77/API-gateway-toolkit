import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vite proxy forwards /analytics requests to the Express server in dev.
 * In production (Render Static Site), VITE_API_URL must be set as an
 * environment variable so the built JS knows where the backend lives.
 */
export default defineConfig(({ mode }) => {
  // loadEnv reads from .env files AND from process.env (which Render sets)
  const env = loadEnv(mode, process.cwd(), '')

  // Print during build so you can confirm the value in Render's build log
  const apiUrl = env.VITE_API_URL || ''
  console.log(`[vite] VITE_API_URL = "${apiUrl || '(not set — using relative /analytics)'}"`)

  return {
    plugins: [react()],

    // Explicitly define the variable so Vite bakes it into the bundle
    // even if the env var is loaded via a non-standard mechanism.
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
    },

    server: {
      port: 5173,
      proxy: {
        '/analytics': {
          target:       'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  }
})
