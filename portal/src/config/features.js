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
