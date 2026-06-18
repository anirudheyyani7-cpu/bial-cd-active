/**
 * Admin-console data access for per-user usage limits. Thin wrappers over the
 * /api/admin endpoints (admin-only, gated server-side). Each throws an Error
 * with a user-ready message on failure so the AdminPage can surface it.
 */
import { authFetch } from './api.js'

/** GET the user list with raw overrides + effective limits, plus the standard-plan defaults. */
export async function fetchUsers(deps = {}) {
  const res = await authFetch('/api/admin/users', {}, deps)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message || `Failed to load users (${res.status}).`)
  }
  const data = await res.json()
  return { users: data.users || [], defaults: data.defaults || {} }
}

/**
 * PATCH a user's limit overrides. `patch` carries any of dailyTokenLimit /
 * contextSoftLimit / contextHardLimit — a number to set, or null to reset that
 * field to the default. Returns the user's new effective limits.
 */
export async function updateUserLimits(username, patch, deps = {}) {
  const res = await authFetch(
    `/api/admin/users/${encodeURIComponent(username)}/limits`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
    deps,
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message || `Failed to update limits (${res.status}).`)
  }
  return res.json()
}
