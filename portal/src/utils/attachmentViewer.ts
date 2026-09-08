/**
 * Open or save an attachment the server already serves, from the object URL `attachmentApi`
 * cached for it. Two helpers, one technique.
 *
 * NEW TAB, NOT A FRAME: the strict CSP blocks embedding a blob:/data: doc in an iframe (the
 * builder preview hit the same gotcha), so a top-level navigation to the object URL is used
 * instead. ANCHOR CLICK, NOT `window.open()`: with `noopener`, `window.open` returns null
 * even on success, so it can't tell "popup blocked" from "opened fine" — a user-gesture
 * anchor click needs no such check; `download` alone decides view vs. save. NEITHER REVOKES
 * THE URL — both take one the caller already holds, and the caller's cache owns its lifetime.
 */

/**
 * Open an EXISTING object URL (e.g. one served by attachmentApi and cached) in a
 * new tab via a user-gesture anchor click. Returns false if there's no URL.
 */
export function openUrlInNewTab(url: string, name?: string): boolean {
  if (!url) return false
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  if (name) a.title = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  return true
}

/**
 * Trigger a DOWNLOAD of an existing (cached) object URL under `name`. Office
 * originals are served as octet-stream (the server can't tell `.docx` from
 * `.xlsx` by bytes), so the filename + extension come from the part's `name` via
 * the `download` attribute — that's what gives the saved file its correct
 * extension (Decision 9).
 */
export function downloadObjectUrl(url: string, name?: string): boolean {
  if (!url) return false
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  return true
}
