/**
 * Server-side configuration + feature gate for PowerPoint (.pptx) deck chat
 * attachments (Gotenberg -> PDF -> Claude vision).
 *
 * The feature is DARK by default: it turns on only when the operator both flips
 * `DECK_ATTACHMENTS_ENABLED=true` AND points `GOTENBERG_URL` at a reachable
 * conversion sidecar. With either missing the `.pptx` ingest path rejects
 * cleanly (never a 500), mirroring the graceful-when-absent posture of the
 * `DEPLOY_ENABLED` flag on the client.
 *
 * Env is read at CALL time (not as load-time module consts) so tests — and a
 * live config change — see the current values, matching the pattern in
 * `object-store.js` (provider read inside the factory, not at import).
 */

/** The OOXML media type for a PowerPoint presentation (`.pptx`). Single source
 *  of truth on the server; mirrored client-side in `utils/attachmentInput.js`. */
export const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** Conservative default page cap. Well under the 600-page Files-API PDF limit
 *  for the 1M-context Opus model (200k-context models cap at 100), and a sane
 *  per-deck cost ceiling. Tunable via `MAX_DECK_PAGES`. */
const DEFAULT_MAX_DECK_PAGES = 100

function posIntOr(raw, fallback) {
  const n = Number.parseInt(raw, 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** The conversion sidecar base URL, or `''` when unset. Trailing slashes are
 *  trimmed so callers can append `/forms/...` without doubling the separator. */
export function gotenbergUrl() {
  return (process.env.GOTENBERG_URL || '').trim().replace(/\/+$/, '')
}

/** Max pages allowed in the converted PDF — a cost AND model-limit governor.
 *  Over-cap conversions are rejected (a deck can't be partially rendered into a
 *  coherent vision block). */
export function maxDeckPages() {
  return posIntOr(process.env.MAX_DECK_PAGES, DEFAULT_MAX_DECK_PAGES)
}

/** True only when the feature is explicitly enabled AND a sidecar URL is set.
 *  Either missing -> the `.pptx` path is rejected with a clear message. */
export function deckAttachmentsEnabled() {
  return process.env.DECK_ATTACHMENTS_ENABLED === 'true' && gotenbergUrl() !== ''
}
