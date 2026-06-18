/**
 * Feedback server module — validation, submission rate limiting, and the
 * authenticated submit handler.
 *
 * The server is the trust boundary. `validateFeedback` is a pure function
 * (mirrors limits.js#validateLimitsPatch) returning
 * `{ ok:true, value } | { ok:false, error }`. The client-side maxLength/counter
 * is advisory only — this is the real check.
 *
 * Author identity comes from the verified token (req.user.sub), NEVER the client
 * body. The `page` field is advisory UX metadata: coerced to a string, truncated,
 * and kept only if path-like (starts with '/', exactly what useLocation().pathname
 * produces) — anything else (javascript:, absolute URLs, garbage) is dropped to
 * '' so it can never be trusted, keyed on, or rendered as a navigable link.
 */
import { randomBytes } from 'node:crypto'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'

// Server-side ceiling on a single feedback message, measured in UTF-8 BYTES so it
// matches the client's TextEncoder byte counter exactly (a char-count cap would
// let multibyte text pass the client and fail here).
export const MAX_FEEDBACK_CHARS = 4000
// Bound the advisory page string so a crafted long value can't bloat a row.
export const MAX_PAGE_CHARS = 256

/**
 * Validate a feedback submission body.
 * @returns {{ok:true, value:{message:string, page:string}} | {ok:false, error:string}}
 */
export function validateFeedback(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Feedback message is required.' }
  }
  const { message } = body
  if (typeof message !== 'string') {
    return { ok: false, error: 'Feedback message is required.' }
  }
  const trimmed = message.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'Feedback message cannot be empty.' }
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_FEEDBACK_CHARS) {
    return { ok: false, error: `Feedback message is too long (max ${MAX_FEEDBACK_CHARS} characters).` }
  }
  // page is advisory UX metadata — NEVER reject the submission on it.
  let page = typeof body.page === 'string' ? body.page : ''
  // Truncate by code point (Array.from), not UTF-16 unit, so a multibyte char at
  // the 256 boundary can't be split into a lone surrogate.
  if (page.length > MAX_PAGE_CHARS) page = Array.from(page).slice(0, MAX_PAGE_CHARS).join('')
  // Keep only same-origin path-like values — exactly what useLocation().pathname
  // produces: a single leading slash NOT followed by another slash. This coerces
  // javascript:, absolute URLs, and protocol-relative '//host' (a latent open-
  // redirect footgun for the deferred "open page" affordance) to '' so page can
  // never be trusted, keyed on, or rendered as a navigable link.
  if (!/^\/(?!\/)/.test(page)) page = ''
  return { ok: true, value: { message: trimmed, page } }
}

/**
 * Per-user submission rate limiter, keyed by username + IP (mirrors
 * makeLoginLimiter). NO optional chain on req.user — this limiter is ALWAYS
 * mounted after requireAuth, so req.user is guaranteed present; an optional chain
 * would silently collapse every request into a shared 'anon':IP bucket if the
 * mount order were ever changed. IP-only keying is wrong because BIAL staff share
 * one corporate egress IP (it would lock out the whole org). Suggested 20/15min.
 * Uses express-rate-limit's default in-memory store, so the ceiling is per-instance
 * — a shared (Redis) store is the follow-up if the portal scales to replicas.
 */
export function makeFeedbackLimiter(options = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.user.sub}:${ipKeyGenerator(req.ip || '0.0.0.0')}`,
    handler: (_req, res) =>
      res.status(429).json({ error: { message: 'Too many feedback submissions. Please try again later.' } }),
    ...options,
  })
}

/**
 * Build the authenticated POST /api/feedback handler over an injected feedbackRepo
 * (DI seam, so the route is unit-testable without a live Cosmos). Identity +
 * doc-identity (`_id`, `createdAt`) are owned here so the repo stays a thin
 * persistence seam; the random `_id` keeps inserts non-colliding (append-only,
 * no natural key).
 */
export function createFeedbackHandler(feedbackRepo) {
  return async function feedbackHandler(req, res) {
    const result = validateFeedback(req.body)
    if (!result.ok) {
      return res.status(400).json({ error: { message: result.error } })
    }
    const doc = {
      _id: randomBytes(16).toString('base64url'),
      username: req.user.sub, // author from the verified token, never the body
      message: result.value.message,
      page: result.value.page,
      createdAt: new Date().toISOString(),
    }
    try {
      await feedbackRepo.addFeedback(doc)
      return res.status(201).json({ ok: true })
    } catch (err) {
      console.error('feedback submit failed:', err.message)
      return res.status(500).json({ error: { message: 'Failed to submit feedback.' } })
    }
  }
}
