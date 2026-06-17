/**
 * Frontend auth/session store — the single owner of token + signout-reason
 * state. Mirrors the defensive try/catch + named-export idiom of chatHistory.js
 * and isolates all token storage so a later cookie migration touches one file.
 *
 * Tokens live in localStorage (+ Authorization: Bearer per the plan's accepted
 * trade-off). Cross-tab refresh is coordinated with the Web Locks API so a
 * rotated refresh token never self-locks-out concurrent tabs; BroadcastChannel
 * is the best-effort fallback where Web Locks is unavailable.
 */
const ACCESS_KEY = 'bial_access_token'
const REFRESH_KEY = 'bial_refresh_token'
const USER_KEY = 'bial_user'
const SIGNOUT_REASON_KEY = 'bial_signout_reason'
const CHAT_HISTORY_KEY = 'bial_chat_history'

const LOCK_NAME = 'bial_token_refresh'
const CHANNEL_NAME = 'bial_auth'

// Valid one-time signout reasons (drive the login banner copy).
export const SIGNOUT_REASONS = {
  EXPIRED: 'session_expired',
  LOGGED_OUT: 'logged_out',
}

export function getAccessToken() {
  return localStorage.getItem(ACCESS_KEY)
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY)
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Persist whatever parts of a session are provided (login sets all three). */
export function setSession({ accessToken, refreshToken, user } = {}) {
  if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken)
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken)
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user))
}

/**
 * Wipe all session state. Also clears chat history (shared terminals) and,
 * when `reason` is given, records a one-time signout reason for the login
 * banner (session_expired | logged_out).
 */
export function clearSession(reason) {
  localStorage.removeItem(ACCESS_KEY)
  localStorage.removeItem(REFRESH_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(CHAT_HISTORY_KEY)
  if (reason) localStorage.setItem(SIGNOUT_REASON_KEY, reason)
}

/** Read and clear the one-time signout reason (for the login screen banner). */
export function consumeSignoutReason() {
  const reason = localStorage.getItem(SIGNOUT_REASON_KEY)
  if (reason) localStorage.removeItem(SIGNOUT_REASON_KEY)
  return reason
}

function decodeClaims(token) {
  try {
    const payload = String(token).split('.')[1]
    if (!payload) return null
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/** True only for a structurally valid, unexpired access token. No network. */
export function isAuthenticated() {
  const claims = decodeClaims(getAccessToken())
  if (!claims || typeof claims.exp !== 'number') return false
  return claims.exp * 1000 > Date.now()
}

function broadcastRotated(session) {
  try {
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(CHANNEL_NAME)
      channel.postMessage({ type: 'rotated', session })
      channel.close()
    }
  } catch {
    // best-effort only
  }
}

/**
 * Start cross-tab session sync: adopt a session rotated by a peer tab. Call
 * once from the app entry (App.jsx) — NOT at import — so the test suite doesn't
 * inherit a stray BroadcastChannel listener that could repopulate storage.
 *
 * On browsers WITHOUT the Web Locks API this lets a peer tab adopt the rotated
 * tokens instead of later presenting an already-rotated (stale) refresh token
 * and signing itself out. With Web Locks present it is harmless belt-and-
 * suspenders — the lock's adopt path already covers cross-tab rotation.
 */
export function startCrossTabSync() {
  try {
    if (typeof BroadcastChannel !== 'function') return undefined
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (e) => {
      if (e.data?.type === 'rotated' && e.data.session?.accessToken) {
        setSession(e.data.session)
      }
    }
    return channel // caller closes it on teardown
  } catch {
    return undefined // best-effort only
  }
}

// In-tab single-flight for the no-Web-Locks fallback path.
let inflight = null

/**
 * Refresh the access token, coordinating so concurrent tabs/callers trigger at
 * most one network refresh. Persists rotated tokens; on failure clears the
 * session with a signout reason. Returns the fresh access token, or null.
 */
export function refreshAccessToken() {
  const staleToken = getAccessToken()

  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    // Web Locks serialize across tabs and concurrent in-tab callers: the first
    // refreshes, peers waiting on the lock adopt the freshly written token. The
    // .catch enforces the documented "returns null on failure" contract even if
    // the lock callback rejects (e.g. an unexpected throw inside refreshOrAdopt).
    return navigator.locks.request(LOCK_NAME, () => refreshOrAdopt(staleToken)).catch(() => null)
  }

  if (inflight) return inflight
  inflight = refreshOrAdopt(staleToken)
    .catch(() => null) // never reject callers — the contract is null-on-failure
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function refreshOrAdopt(staleToken) {
  // A peer already rotated while we waited for the lock → adopt, don't refresh.
  const current = getAccessToken()
  if (current && current !== staleToken && isAuthenticated()) {
    return current
  }

  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    clearSession(SIGNOUT_REASONS.EXPIRED)
    return null
  }

  try {
    // Bound the refresh: a hung server must not hold the Web Lock (and thereby
    // block every other in-tab refresh) indefinitely. The timeout surfaces as an
    // AbortError caught below, which fails closed like any other network error.
    const timeoutSignal =
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: timeoutSignal,
    })
    if (!res.ok) {
      clearSession(SIGNOUT_REASONS.EXPIRED)
      return null
    }
    const data = await res.json().catch(() => null)
    if (!data?.accessToken) {
      clearSession(SIGNOUT_REASONS.EXPIRED)
      return null
    }
    const session = { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user }
    setSession(session)
    broadcastRotated(session)
    return data.accessToken
  } catch {
    // Network error — fail closed without nuking the (possibly still valid)
    // session reason; treat as expired so the caller redirects to login.
    clearSession(SIGNOUT_REASONS.EXPIRED)
    return null
  }
}
