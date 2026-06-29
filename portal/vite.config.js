import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    // Disable vite's own dev-server CORS. The builder live-preview runs in a
    // sandboxed, opaque-origin iframe (Origin: null) and calls the Data Service at
    // /api/apps/:id/records cross-origin. Vite 6's built-in CORS middleware answers
    // the OPTIONS preflight ITSELF — without an Access-Control-Allow-Origin for the
    // null origin — so the browser blocks the request ("Failed to fetch"). Turning
    // it off lets the preflight proxy through to Express, whose makeDataServiceCors
    // reflects Origin: null correctly (matching production, where there is no vite).
    cors: false,
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