/**
 * Authenticated fetch for JSON API calls (admin console, future authed reads).
 *
 * Attaches the Bearer access token and, on a pre-body 401, refreshes the token
 * once and retries — the same admission pattern as fetchClaudeStream, factored
 * out so non-streaming callers get token rotation for free. Dependencies are
 * injected so it's testable without a real network or a React render.
 */
import { getAccessToken, refreshAccessToken } from './auth.js'

export async function authFetch(
  url,
  opts = {},
  { getToken = getAccessToken, refresh = refreshAccessToken, fetchImpl = fetch } = {},
) {
  const call = (token) =>
    fetchImpl(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })

  let res = await call(getToken())
  if (res.status === 401) {
    const fresh = await refresh()
    if (fresh) res = await call(fresh)
  }
  return res
}
