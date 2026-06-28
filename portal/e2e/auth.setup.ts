import { test as setup, expect } from '@playwright/test'
import { createHmac, randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_FILE = path.join(dirname, '../playwright/.auth/user.json')

// Mint the access token inline (node:crypto), NOT via the server's signAccessToken.
// jsonwebtoken is CommonJS and its require-graph trips Playwright's ESM loader
// ("Unexpected module status 3"). HS256 is trivial, and the server verifies with
// algorithms:['HS256'] against the SAME JWT_SECRET, so an inline token verifies
// identically. claims mirror signAccessToken: { sub, username, role, iat, exp }.
function b64url(input: string): string {
  return Buffer.from(input).toString('base64url')
}
function mintAccessToken(claims: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const iat = Math.floor(Date.now() / 1000)
  const payload = { ...claims, iat, exp: iat + ttlSeconds }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${sig}`
}
// Same shape as the server's generateRefreshToken: base64url(user).base64url(rand).
// It matches no stored hash (so a refresh would 401), but the suite finishes well
// within the access token's life, so it never refreshes.
function mintRefreshToken(username: string): string {
  return `${Buffer.from(username, 'utf8').toString('base64url')}.${randomBytes(32).toString('base64url')}`
}

// Seed shared auth by minting a valid access token directly with JWT_SECRET and
// injecting the three localStorage keys the SPA reads. We do NOT call
// POST /api/auth/login: it is rate-limited to 10 / 15 min per user+IP with no
// override, and re-running the suite while authoring would 429 and collapse every
// spec. Exactly one spec (login.spec.ts) exercises the real UI login for coverage.
setup('seed shared auth (mint JWT, no login request)', async ({ page }) => {
  const email = process.env.E2E_QA_EMAIL
  const secret = process.env.JWT_SECRET
  if (!email) throw new Error('E2E_QA_EMAIL not set — copy .env.e2e.example to .env.e2e and fill it.')
  if (!secret) throw new Error('JWT_SECRET not set — needed to mint the seeded token (must match the target server).')

  // 1h TTL: comfortably outlasts a suite run (the server only checks exp > now).
  const accessToken = mintAccessToken({ sub: email, username: email, role: 'user' }, secret, 3600)
  const refreshToken = mintRefreshToken(email)
  const user = { username: email, name: 'E2E QA', role: 'user', isAdmin: false }

  // localStorage is origin-scoped — land on the target origin first, then seed.
  await page.goto('/login')
  await page.evaluate(
    ({ accessToken, refreshToken, user }) => {
      localStorage.setItem('bial_access_token', accessToken)
      localStorage.setItem('bial_refresh_token', refreshToken)
      localStorage.setItem('bial_user', JSON.stringify(user))
    },
    { accessToken, refreshToken, user },
  )

  // Prove the seed authenticates: a guarded route no longer bounces to /login.
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/dashboard/)

  await page.context().storageState({ path: AUTH_FILE })
})
