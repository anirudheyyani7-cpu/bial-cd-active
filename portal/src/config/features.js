/**
 * UI feature flags (interim, hardcoded). Single source of truth for whether a
 * feature is surfaced in the running app.
 *
 * CHAT_ENABLED temporarily hides the BIAL Chat general assistant from every
 * visible entry point (navbar link, search dropdown, dashboard card). This is a
 * suppression, NOT a removal: the `/chat`, `/chat/history`, and `/chat/:chatId`
 * routes stay live and reachable by direct URL. Flip this back to `true` to
 * restore all entry points — that one-line change is the whole "un-hide".
 */
export const CHAT_ENABLED = false

/**
 * DEPLOY_ENABLED hides the app deployment workflow — the App Builder "Submit for
 * deployment" bar (DeployBar) and the Admin → App Registry review/approve tab.
 * Suppression, NOT removal: the deploy/admin API routes stay live and the builder
 * still provisions a data store for the live preview. Flip back to `true` to
 * restore both entry points — that one-line change is the whole "un-hide".
 */
export const DEPLOY_ENABLED = false

/**
 * DECK_ATTACHMENTS_ENABLED surfaces PowerPoint (.pptx) chat attachments in the
 * composer (file picker + drag/drop allowlist). A deck is converted to a PDF by
 * an in-tenant Gotenberg sidecar and read by Claude with vision — unlike Word/
 * Excel, which are read as extracted text. This client flag only controls whether
 * .pptx is OFFERED in the UI; the server independently enforces its own gate
 * (DECK_ATTACHMENTS_ENABLED env + a reachable GOTENBERG_URL) and rejects .pptx
 * cleanly when off. Enabling the feature means flipping BOTH this flag and the
 * server env — that pair is the whole "turn it on".
 */
export const DECK_ATTACHMENTS_ENABLED = true
