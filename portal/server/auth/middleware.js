/**
 * requireAuth — admits only requests bearing a valid access JWT.
 *
 * Gates `/api/claude` (rejecting BEFORE any SSE headers/proxy call) and
 * `/api/auth/logout` (so the user is identified from the verified `sub`, not a
 * client-supplied name). 401 for every token failure; 403 is reserved for
 * future role checks. Response uses the app-wide `{ error: { message } }` shape.
 */
import { verifyAccessToken } from './tokens.js'

function unauthorized(res, message) {
  return res.status(401).json({ error: { message } })
}

export function requireAuth(req, res, next) {
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/)
  if (!match) {
    return unauthorized(res, 'Missing or malformed Authorization header')
  }

  try {
    req.user = verifyAccessToken(match[1].trim())
    return next()
  } catch {
    return unauthorized(res, 'Invalid or expired token')
  }
}

/**
 * requireAdmin — gate admin-only routes by the verified token's role. Runs
 * AFTER requireAuth (which populates req.user from the signed JWT), so the role
 * is trusted, not client-supplied. 403 (authenticated but not allowed), the
 * counterpart to requireAuth's 401 (not authenticated).
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: { message: 'Admin access required.' } })
  }
  return next()
}
