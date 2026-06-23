/**
 * App-context middleware — resolves and verifies the app on EVERY data request,
 * and enforces `loginRequired` LIVE from the registry (Decisions 3, 4, 5).
 *
 * `requireAppKey` reads the `X-App-Key` header, point-reads the registry, and
 * attaches a VERIFIED `req.appCtx = { appId, loginRequired, status }`. The app key
 * is a publishable SCOPING LABEL, NOT authentication (Decision 3) — validation is
 * only "this key names a real, non-killed app, and the URL it's used on matches
 * that app." The composite URL-vs-key cross-check closes any cross-app leak: a
 * valid key for app X used on app Y's URL 404s.
 *
 * `requireLoginIfRequired` then reads `req.appCtx.loginRequired` — resolved on
 * THIS request from the registry, never from app code or a token claim — and runs
 * the shared portal `requireAuth` when true. Removing the login box from an app's
 * JSX therefore cannot bypass the guard ("login cannot be prompted away"); the
 * flag is an admin-owned setting, and the live read means flipping it changes the
 * very next request. Mirrors the live-gate doctrine of the daily-limit check.
 *
 * The app key is documented HERE as "not a secret": real protection is the
 * IP-restricted network wall + (for CRUD apps) the shared login, not the key.
 */
import { requireAuth } from './auth/middleware.js'

// Statuses whose data plane is OPEN to reads/writes. draft/pending/approved pass
// (build-time writes to a draft are intended, and a pending app keeps serving);
// disabled (kill-switch) and rejected are closed.
const ACTIVE_STATUSES = new Set(['draft', 'pending', 'approved'])

function deny(res, status, message) {
  return res.status(status).json({ error: { message } })
}

/**
 * @param {{ registryRepo: object }} deps
 */
export function createAppContext({ registryRepo }) {
  if (!registryRepo) throw new Error('createAppContext: registryRepo is required')

  /**
   * Resolve the app from `X-App-Key` and attach `req.appCtx`. 401 unknown/missing
   * key (the key is NOT a secret, so the 401 is generic — no enumeration value);
   * 403 a disabled/rejected app (kill-switch); 404 when the URL :appId does not
   * match the key's app (no cross-app leak). draft/pending/approved pass.
   */
  async function requireAppKey(req, res, next) {
    try {
      const appKey = req.headers['x-app-key']
      if (typeof appKey !== 'string' || appKey.length === 0) {
        return deny(res, 401, 'Missing or invalid app key.')
      }
      const app = await registryRepo.getByKey(appKey)
      if (!app) return deny(res, 401, 'Missing or invalid app key.')
      if (!ACTIVE_STATUSES.has(app.status)) return deny(res, 403, 'This app is not available.')
      // The key names app X; this request must be on app X's URL. A mismatch is a
      // cross-app probe — 404 (same as a non-existent app, no information leak).
      if (req.params.appId !== app._id) return deny(res, 404, 'App not found.')
      req.appCtx = { appId: app._id, loginRequired: Boolean(app.loginRequired), status: app.status }
      return next()
    } catch (err) {
      console.error('requireAppKey error:', err.message)
      return deny(res, 500, 'App verification failed. Please retry.')
    }
  }

  /**
   * Enforce the live `loginRequired` flag. When true, run the shared portal
   * `requireAuth` (sets `req.user` from the portal access token, 401 otherwise);
   * when false, allow anonymous (the data routes record actor `null`). Fails
   * CLOSED if `req.appCtx` is somehow unset (misordered mount) — never open.
   */
  function requireLoginIfRequired(req, res, next) {
    if (!req.appCtx) return deny(res, 500, 'App context not resolved.')
    if (req.appCtx.loginRequired) return requireAuth(req, res, next)
    return next()
  }

  return { requireAppKey, requireLoginIfRequired }
}
