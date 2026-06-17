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
