import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setSession,
  clearSession,
  getAccessToken,
  getRefreshToken,
  getStoredUser,
  consumeSignoutReason,
  isAuthenticated,
  refreshAccessToken,
} from '../auth.js'

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function jwtWithExp(sub, secondsFromNow) {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, username: sub, role: 'user', exp })}.sig`
}
const validJwt = (sub = 'alice') => jwtWithExp(sub, 3600)
const expiredJwt = (sub = 'alice') => jwtWithExp(sub, -3600)

beforeEach(() => {
  localStorage.clear()
  delete navigator.locks // default to the no-Web-Locks fallback path
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session storage', () => {
  it('setSession then getters round-trip; clearSession wipes tokens/user but PRESERVES chat history', () => {
    setSession({ accessToken: 'a-tok', refreshToken: 'r-tok', user: { username: 'alice', isAdmin: true } })
    // Per-user namespaced history must survive token expiry / logout (U8).
    localStorage.setItem('bial_chat_history:alice', '[{"id":1}]')

    expect(getAccessToken()).toBe('a-tok')
    expect(getRefreshToken()).toBe('r-tok')
    expect(getStoredUser()).toMatchObject({ username: 'alice', isAdmin: true })

    clearSession('logged_out')
    expect(getAccessToken()).toBeNull()
    expect(getRefreshToken()).toBeNull()
    expect(getStoredUser()).toBeNull()
    expect(localStorage.getItem('bial_chat_history:alice')).toBe('[{"id":1}]') // history survives
  })

  it('consumeSignoutReason returns the reason then clears it (one-time)', () => {
    clearSession('session_expired')
    expect(consumeSignoutReason()).toBe('session_expired')
    expect(consumeSignoutReason()).toBeNull()
  })

  it('getStoredUser returns null for absent or corrupt JSON', () => {
    expect(getStoredUser()).toBeNull()
    localStorage.setItem('bial_user', '{not json')
    expect(getStoredUser()).toBeNull()
  })
})

describe('isAuthenticated', () => {
  it('is false for missing, malformed, and expired tokens; true for a valid one', () => {
    expect(isAuthenticated()).toBe(false)
    setSession({ accessToken: 'garbage' })
    expect(isAuthenticated()).toBe(false)
    setSession({ accessToken: expiredJwt() })
    expect(isAuthenticated()).toBe(false)
    setSession({ accessToken: validJwt() })
    expect(isAuthenticated()).toBe(true)
  })
})

describe('refreshAccessToken', () => {
  it('coalesces concurrent refreshes into one request via the Web Lock; both adopt the rotated token', async () => {
    setSession({ accessToken: validJwt('old'), refreshToken: 'rt-old', user: { username: 'alice' } })

    // Serializing navigator.locks mock: runs callbacks one at a time.
    let chain = Promise.resolve()
    const request = vi.fn((_name, cb) => {
      const result = chain.then(() => cb())
      chain = result.then(() => {}, () => {})
      return result
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })

    const rotated = validJwt('new')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ accessToken: rotated, refreshToken: 'rt-new', user: { username: 'alice' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([refreshAccessToken(), refreshAccessToken()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({ method: 'POST' }))
    expect(a).toBe(rotated)
    expect(b).toBe(rotated)
    expect(getAccessToken()).toBe(rotated)
    expect(getRefreshToken()).toBe('rt-new')
  })

  it('adopts a peer-rotated token under the lock without issuing its own refresh', async () => {
    setSession({ accessToken: validJwt('old'), refreshToken: 'rt-old', user: { username: 'alice' } })
    const rotated = validJwt('new')

    // While we wait for the lock, a peer tab rotates and writes the fresh token.
    const request = vi.fn(async (_name, cb) => {
      setSession({ accessToken: rotated, refreshToken: 'rt-new', user: { username: 'alice' } })
      return cb()
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const token = await refreshAccessToken()
    expect(token).toBe(rotated)
    expect(fetchMock).not.toHaveBeenCalled() // adopted the peer's token; no network refresh
  })

  it('clears the session and records session_expired when refresh fails', async () => {
    setSession({ accessToken: validJwt('old'), refreshToken: 'rt', user: { username: 'alice' } })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))

    const result = await refreshAccessToken()
    expect(result).toBeNull()
    expect(getAccessToken()).toBeNull()
    expect(consumeSignoutReason()).toBe('session_expired')
  })

  it('fails OPEN on a network/abort error: returns null but PRESERVES the session (no logout on a blip)', async () => {
    setSession({ accessToken: expiredJwt('alice'), refreshToken: 'rt', user: { username: 'alice' } })
    // fetch throwing (network down) or the AbortSignal.timeout firing both reach
    // the catch; unlike a 401, this must NOT clear the session — the refresh
    // token is still valid, so the next navigation/API call can retry.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    const result = await refreshAccessToken()
    expect(result).toBeNull()
    expect(getRefreshToken()).toBe('rt')
    expect(getStoredUser()).toMatchObject({ username: 'alice' })
    expect(consumeSignoutReason()).toBeNull() // not marked expired — no logout
  })

  it('returns null and clears when no refresh token is present', async () => {
    const result = await refreshAccessToken()
    expect(result).toBeNull()
    expect(consumeSignoutReason()).toBe('session_expired')
  })
})
