import { defineConfig } from 'vitest/config'

// Two projects so server code runs under Node and frontend utils under jsdom
// (localStorage / navigator.locks / BroadcastChannel are needed by auth.js).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/**/*.test.js'],
          // Auth tests do real Argon2id hashing (CPU-bound, runs on the libuv
          // threadpool). Running the server test files in parallel starves that
          // threadpool and intermittently resets an in-flight supertest socket
          // ("socket hang up", flaking AE6). One fork → no cross-file Argon2
          // contention. The server suite is small, so serial is still fast.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        // Automatic JSX runtime so component tests can render JSX (e.g. the
        // shared AttachmentChips chip) without importing React in scope —
        // esbuild injects react/jsx-runtime, matching the app's vite.config.js.
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['src/**/*.test.{js,jsx}'],
        },
      },
    ],
  },
})
