/**
 * Per-user usage-limit defaults + resolution (interim auth backend).
 *
 * Two kinds of limit, both now per-user-configurable on top of a shared
 * "standard plan" default:
 *  - dailyTokenLimit   — server-enforced token ceiling per user per IST day.
 *  - contextSoft/Hard  — the per-conversation guardrail thresholds the SPA uses
 *                        to warn (soft) and hard-stop (hard). The hard limit can
 *                        be LOWERED per user but never raised past the model's
 *                        real 200k context window — the model rejects more.
 *
 * A user document carries an optional sparse `limits` object; any absent field
 * falls back to the default, so a freshly seeded user (no `limits`) gets the
 * standard plan and an admin raises a single field to "approve a higher plan".
 *
 * This module is the single source of truth, imported by the /api/claude gate,
 * the usage endpoint, the login/refresh profile, and the admin routes — so the
 * number a user is enforced against, billed against, and shown are all one
 * definition.
 */

// The Opus 4.7 context window. A per-user hard limit is clamped to this — you
// cannot grant more context than the model can accept.
export const MODEL_CONTEXT_WINDOW = 200_000

// The standard plan (defaults applied to every user without an override).
export const DEFAULT_DAILY_TOKEN_LIMIT = 1_000_000
export const DEFAULT_CONTEXT_SOFT_LIMIT = 150_000
export const DEFAULT_CONTEXT_HARD_LIMIT = 200_000

// The only fields an admin can override per user.
export const LIMIT_FIELDS = ['dailyTokenLimit', 'contextSoftLimit', 'contextHardLimit']

function posIntOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * The standard-plan limits. Daily comes from DAILY_TOKEN_LIMIT (validated at
 * boot by server.js; a bad value falls back here too); context is fixed to the
 * constants. Read fresh each call so an env change between requests is honoured.
 */
export function defaultLimits() {
  const envDaily = Number.parseInt(process.env.DAILY_TOKEN_LIMIT, 10)
  return {
    dailyTokenLimit: envDaily > 0 ? envDaily : DEFAULT_DAILY_TOKEN_LIMIT,
    contextSoftLimit: DEFAULT_CONTEXT_SOFT_LIMIT,
    contextHardLimit: DEFAULT_CONTEXT_HARD_LIMIT,
  }
}

/**
 * Resolve a user's EFFECTIVE limits: per-user overrides on top of `defaults`,
 * each validated and clamped. Never throws on user/DB data — an invalid or
 * absent override silently falls back to the default. This is the final safety
 * net, so a partial admin patch that briefly stored soft >= hard still reads
 * back as a sane soft < hard <= window.
 *
 * @param {object|null} user - a user document (may carry `limits`), or null.
 */
export function resolveUserLimits(user, defaults = defaultLimits()) {
  const o = (user && typeof user === 'object' && user.limits) || {}
  const dailyTokenLimit = posIntOr(o.dailyTokenLimit, defaults.dailyTokenLimit)
  // Hard limit: per-user value (or default), never above the model window.
  const contextHardLimit = Math.min(
    posIntOr(o.contextHardLimit, defaults.contextHardLimit),
    MODEL_CONTEXT_WINDOW,
  )
  // Soft (warn) must stay strictly below hard, and at least 1.
  let contextSoftLimit = posIntOr(o.contextSoftLimit, defaults.contextSoftLimit)
  contextSoftLimit = Math.max(1, Math.min(contextSoftLimit, contextHardLimit - 1))
  return { dailyTokenLimit, contextSoftLimit, contextHardLimit }
}

/**
 * Validate an admin PATCH body for a user's limit overrides. Each field is
 * optional; a value of `null` clears that override (revert to default); a
 * number must be a positive integer. The admin UI sends soft+hard together, so
 * the cross-field `soft < hard` check applies when both are present; a single
 * field is still accepted (resolveUserLimits re-clamps on read).
 *
 * @returns {{ok:true, limits:object} | {ok:false, error:string}}
 */
export function validateLimitsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be an object of limit fields.' }
  }
  const limits = {}
  for (const field of LIMIT_FIELDS) {
    if (!(field in body)) continue
    const v = body[field]
    if (v === null) {
      limits[field] = null // clear → fall back to default
      continue
    }
    if (!Number.isInteger(v) || v <= 0) {
      return { ok: false, error: `${field} must be a positive integer, or null to reset to default.` }
    }
    limits[field] = v
  }
  if (Object.keys(limits).length === 0) {
    return { ok: false, error: 'Provide at least one of: dailyTokenLimit, contextSoftLimit, contextHardLimit.' }
  }
  if (Number.isInteger(limits.contextHardLimit) && limits.contextHardLimit > MODEL_CONTEXT_WINDOW) {
    return {
      ok: false,
      error: `contextHardLimit cannot exceed the model context window of ${MODEL_CONTEXT_WINDOW.toLocaleString('en-US')} tokens.`,
    }
  }
  if (
    Number.isInteger(limits.contextSoftLimit) &&
    Number.isInteger(limits.contextHardLimit) &&
    limits.contextSoftLimit >= limits.contextHardLimit
  ) {
    return { ok: false, error: 'contextSoftLimit must be less than contextHardLimit.' }
  }
  return { ok: true, limits }
}
