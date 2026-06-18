/**
 * User-feedback submission. Thin authenticated wrapper over POST /api/feedback
 * (mirrors src/utils/admin.js). Throws an Error with a user-ready message on
 * failure so the modal can surface it inline. Dependencies are injected so it's
 * testable without a real token/network.
 */
import { authFetch } from './api.js'

/** POST a feedback message + the page it was sent from. Resolves to the JSON body. */
export async function submitFeedback(message, page, deps = {}) {
  const res = await authFetch(
    '/api/feedback',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, page }),
    },
    deps,
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message || `Failed to submit feedback (${res.status}).`)
  }
  return res.json()
}
