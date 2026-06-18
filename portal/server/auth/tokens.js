/**
 * Token primitives — HS256 access JWTs + self-describing opaque refresh tokens.
 *
 * Access JWT: minimal claims (sub/username/role/iat/exp), HS256, verified with
 * a pinned algorithm allowlist + small clock tolerance.
 *
 * Refresh token: `base64url(username) + "." + base64url(randomBytes(32))`. The
 * server splits off the username to point-read the right user, then compares
 * the SHA-256 of the WHOLE token to the stored hash — the username is only a
 * lookup hint and is never trusted for authorization.
 */
import { randomBytes, createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'

const B64URL = /^[A-Za-z0-9_-]+$/

function getSecret() {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET not set. Copy .env.example to .env.')
  return secret
}

/** Sign a short-lived access token with minimal claims. */
export function signAccessToken({ sub, username, role }) {
  return jwt.sign({ sub, username, role }, getSecret(), {
    algorithm: 'HS256',
    expiresIn: process.env.ACCESS_TOKEN_TTL || '15m',
  })
}

/** Verify an access token (algorithm pinned to HS256). Throws on failure. */
export function verifyAccessToken(token) {
  return jwt.verify(token, getSecret(), {
    algorithms: ['HS256'],
    clockTolerance: 30, // seconds
  })
}

/** Generate a self-describing opaque refresh token for `username`. */
export function generateRefreshToken(username) {
  const encUser = Buffer.from(String(username), 'utf8').toString('base64url')
  const encRand = randomBytes(32).toString('base64url')
  return `${encUser}.${encRand}`
}

/** Extract the embedded username (lookup hint only). null if malformed. */
export function parseRefreshToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encUser, encRand] = parts
  if (!B64URL.test(encUser) || !B64URL.test(encRand)) return null
  const username = Buffer.from(encUser, 'base64url').toString('utf8')
  return username || null
}

/** SHA-256 (hex) of the whole presented token — the actual auth check. */
export function hashRefreshToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

function ttlToMs(ttl, fallbackMs) {
  const m = String(ttl ?? '').trim().match(/^(\d+)\s*([smhd])?$/)
  if (!m) return fallbackMs
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || 's']
  return Number(m[1]) * mult
}

/** ISO expiry for a freshly issued refresh token (default 7d). */
export function refreshExpiry(now = Date.now()) {
  const ms = ttlToMs(process.env.REFRESH_TOKEN_TTL, 7 * 86_400_000)
  return new Date(now + ms).toISOString()
}

/**
 * Fail-loud validation of the token configuration, run once at startup. Catches
 * a missing/empty JWT_SECRET, a malformed ACCESS_TOKEN_TTL (which would make
 * jwt.sign throw and turn EVERY login/refresh into a 500), a non-positive access
 * TTL (which mints already-expired tokens), and a REFRESH_TOKEN_TTL that the
 * stricter ttlToMs parser would silently swallow into the 7d default. Throws on
 * any problem so a misconfig surfaces at boot, not on the first real request.
 */
export function validateTokenConfig() {
  getSecret() // throws if JWT_SECRET is unset

  let decoded
  try {
    decoded = verifyAccessToken(signAccessToken({ sub: '_boot', username: '_boot', role: 'user' }))
  } catch (err) {
    throw new Error(`Invalid ACCESS_TOKEN_TTL ("${process.env.ACCESS_TOKEN_TTL}"): ${err.message}`)
  }
  if (!(decoded.exp > decoded.iat)) {
    throw new Error(`ACCESS_TOKEN_TTL must be a positive duration (got "${process.env.ACCESS_TOKEN_TTL}").`)
  }

  const rawRefresh = process.env.REFRESH_TOKEN_TTL
  if (rawRefresh != null && rawRefresh !== '' && !/^\d+\s*[smhd]?$/.test(String(rawRefresh).trim())) {
    throw new Error(
      `REFRESH_TOKEN_TTL "${rawRefresh}" must be <number><s|m|h|d> (e.g. 7d, 168h); ` +
        'other formats silently fall back to 7d.',
    )
  }
  if (ttlToMs(rawRefresh, 7 * 86_400_000) <= 0) {
    throw new Error(`REFRESH_TOKEN_TTL must be a positive duration (got "${rawRefresh}").`)
  }
}
