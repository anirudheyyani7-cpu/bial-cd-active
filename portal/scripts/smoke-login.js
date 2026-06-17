/**
 * Local smoke test: run the full login -> refresh -> logout cycle against the
 * REAL database pointed to by MONGODB_URI (no mocks). Proves the end-to-end auth
 * wiring — useful after changing the data layer or the connection string.
 *
 *   node scripts/smoke-login.js <username> <password>
 */
import 'dotenv/config'
import request from 'supertest'
import { createApp } from '../server.js'
import { createUsersRepo } from '../server/users-repo.js'
import { getUsersCollection } from '../server/cosmos.js'

const [username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error('Usage: node scripts/smoke-login.js <username> <password>')
  process.exit(1)
}

// No claudeClient needed — the auth routes don't touch the Claude relay. The
// usage repo is required by createApp but never exercised here (smoke-login hits
// only /api/auth/*), so a trivial no-op fake satisfies the guard.
const noopUsageRepo = { getUsage: async () => null, addUsage: async () => {} }
const app = createApp({ repo: createUsersRepo(await getUsersCollection()), usageRepo: noopUsageRepo })

const login = await request(app).post('/api/auth/login').send({ username, password })
console.log('login:                       ', login.status, login.status === 200 ? '✓' : JSON.stringify(login.body))
if (login.status !== 200) process.exit(1)

const refresh = await request(app).post('/api/auth/refresh').send({ refreshToken: login.body.refreshToken })
console.log('refresh (rotate):            ', refresh.status, refresh.status === 200 ? '✓' : JSON.stringify(refresh.body))

const access = refresh.body.accessToken || login.body.accessToken
const logout = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${access}`)
console.log('logout:                      ', logout.status, logout.status === 200 ? '✓' : JSON.stringify(logout.body))

const after = await request(app).post('/api/auth/refresh').send({ refreshToken: refresh.body.refreshToken })
console.log('refresh after logout (→401): ', after.status, after.status === 401 ? '✓' : JSON.stringify(after.body))

console.log('\nprofile returned to the client:', JSON.stringify(login.body.user))
process.exit(0)
