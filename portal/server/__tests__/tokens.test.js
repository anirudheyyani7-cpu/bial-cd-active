import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  parseRefreshToken,
  hashRefreshToken,
  refreshExpiry,
  validateTokenConfig,
} from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

afterEach(() => {
  delete process.env.ACCESS_TOKEN_TTL
})

describe('access tokens (HS256)', () => {
  it('signs then verifies, exposing sub/username/role', () => {
    const token = signAccessToken({ sub: 'alice', username: 'alice', role: 'admin' })
    const decoded = verifyAccessToken(token)
    expect(decoded).toMatchObject({ sub: 'alice', username: 'alice', role: 'admin' })
    expect(decoded.iat).toBeTypeOf('number')
    expect(decoded.exp).toBeTypeOf('number')
  })

  it('rejects a tampered/garbage token with JsonWebTokenError', () => {
    expect(() => verifyAccessToken('not.a.jwt')).toThrow(jwt.JsonWebTokenError)
  })

  it('rejects an expired token with TokenExpiredError', () => {
    process.env.ACCESS_TOKEN_TTL = '-120s' // past the verify clock tolerance
    const token = signAccessToken({ sub: 'alice', username: 'alice', role: 'user' })
    expect(() => verifyAccessToken(token)).toThrow(jwt.TokenExpiredError)
  })

  it('rejects a token signed with a different algorithm (algorithm pinning)', () => {
    const hs512 = jwt.sign({ sub: 'mallory' }, process.env.JWT_SECRET, { algorithm: 'HS512' })
    expect(() => verifyAccessToken(hs512)).toThrow(jwt.JsonWebTokenError)
  })

  it('rejects an unsigned "none" algorithm token', () => {
    const none = jwt.sign({ sub: 'mallory' }, null, { algorithm: 'none' })
    expect(() => verifyAccessToken(none)).toThrow(jwt.JsonWebTokenError)
  })
})

describe('self-describing refresh tokens', () => {
  it('round-trips the embedded username', () => {
    const token = generateRefreshToken('alice')
    expect(parseRefreshToken(token)).toBe('alice')
  })

  it('round-trips a username with non-ascii / separators safely', () => {
    const token = generateRefreshToken('ali.ce+1')
    expect(parseRefreshToken(token)).toBe('ali.ce+1')
  })

  it('two generated tokens differ', () => {
    expect(generateRefreshToken('alice')).not.toBe(generateRefreshToken('alice'))
  })

  it('hashRefreshToken is stable per input and differs across inputs', () => {
    const t1 = generateRefreshToken('alice')
    expect(hashRefreshToken(t1)).toBe(hashRefreshToken(t1))
    expect(hashRefreshToken(t1)).not.toBe(hashRefreshToken(generateRefreshToken('alice')))
  })

  it('rejects malformed tokens cleanly (no separator / non-base64)', () => {
    expect(parseRefreshToken('garbage-no-dot')).toBeNull()
    expect(parseRefreshToken('a.b!c')).toBeNull()
    expect(parseRefreshToken('')).toBeNull()
    expect(parseRefreshToken(null)).toBeNull()
    expect(parseRefreshToken('a.b.c')).toBeNull()
  })

  it('refreshExpiry returns a future ISO timestamp', () => {
    process.env.REFRESH_TOKEN_TTL = '7d'
    const iso = refreshExpiry(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(iso).toBe('2026-01-08T00:00:00.000Z')
  })
})

describe('validateTokenConfig (boot validation)', () => {
  afterEach(() => {
    delete process.env.ACCESS_TOKEN_TTL
    delete process.env.REFRESH_TOKEN_TTL
  })

  it('passes for a valid secret + TTLs', () => {
    process.env.ACCESS_TOKEN_TTL = '15m'
    process.env.REFRESH_TOKEN_TTL = '7d'
    expect(() => validateTokenConfig()).not.toThrow()
  })

  it('throws on a malformed ACCESS_TOKEN_TTL (would 500 every login)', () => {
    process.env.ACCESS_TOKEN_TTL = 'not-a-duration'
    expect(() => validateTokenConfig()).toThrow(/ACCESS_TOKEN_TTL/)
  })

  it('throws on a non-positive ACCESS_TOKEN_TTL (would mint expired tokens)', () => {
    process.env.ACCESS_TOKEN_TTL = '0'
    expect(() => validateTokenConfig()).toThrow(/ACCESS_TOKEN_TTL/)
  })

  it('throws on a REFRESH_TOKEN_TTL the parser would silently default to 7d', () => {
    process.env.REFRESH_TOKEN_TTL = '7 days'
    expect(() => validateTokenConfig()).toThrow(/REFRESH_TOKEN_TTL/)
  })
})
