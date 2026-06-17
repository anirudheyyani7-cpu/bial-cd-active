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
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['src/**/*.test.{js,jsx}'],
        },
      },
    ],
  },
})
