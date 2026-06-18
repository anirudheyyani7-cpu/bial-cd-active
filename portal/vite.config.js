import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    proxy: {
      // Proxy the whole API surface (auth + claude) to the Express server.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // The builder preview renderer is served by Express (with its own relaxed
      // CSP); proxy it so the live preview works in dev too.
      '/preview': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})