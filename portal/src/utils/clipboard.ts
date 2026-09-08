/**
 * COPYING TEXT TO THE SYSTEM CLIPBOARD — the portal's only clipboard route.
 *
 * WHY THIS EXISTS
 * There was no clipboard code anywhere in this tree, so the first surface to need one
 * (the published app's address) would otherwise have written `navigator.clipboard
 * .writeText(url)` inline — and inline is exactly where the refusal path gets skipped.
 *
 * THE REFUSAL PATH IS THE WHOLE REASON THIS EXISTS. `navigator.clipboard` is a
 * secure-context API: on plain `http://` it is not merely a rejected promise, the property
 * is UNDEFINED, so an inline `await navigator.clipboard.writeText(…)` throws a
 * `TypeError` rather than rejecting. And on a secure origin it still rejects when the
 * browser denies the permission or the document is not focused. Three shapes, one of which
 * is not a rejection at all — a caller that only wrote `.catch()` would let the first one
 * escape as an unhandled error, and a caller that wrote neither would fail in total
 * silence — and a failure that reaches a citizen as silence is the one outcome this module
 * exists to prevent.
 *
 * So the three collapse into ONE typed error the caller must handle, and the caller is
 * then obliged to say something a citizen can act on. This module deliberately does NOT
 * fall back to `document.execCommand('copy')`: it is deprecated, it needs a live
 * selection, and a "fallback" that also fails silently is how one unhandled path becomes
 * two.
 */

/**
 * The clipboard said no — unavailable, denied, or the write itself failed.
 *
 * ONE ERROR FOR THREE CAUSES ON PURPOSE. A caller cannot do anything different about a
 * missing API than about a denied permission: both mean "the text is not on their
 * clipboard", and the remedy offered to the citizen is the same either way. The original
 * failure rides on `cause` for anyone debugging, and is never shown to a citizen —
 * internal errors do not reach the frontend's own copy.
 */
export class ClipboardRefused extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ClipboardRefused'
  }
}

/**
 * Put `text` on the system clipboard, or throw `ClipboardRefused`.
 *
 * NOTHING IS RETURNED, and no boolean either: a boolean is a return value you can ignore
 * by accident, and this is precisely the call whose failure must not be ignorable —
 * never return a value to signal an error.
 */
export async function copyToClipboard(text: string): Promise<void> {
  // ANNOTATED `| undefined` DELIBERATELY. The DOM lib types `navigator.clipboard` as a
  // non-optional `Clipboard`, which is a lie on an insecure origin — and comparing a
  // non-nullable type against `undefined` is a type error, so the widening has to happen
  // here for the guard below to be expressible at all.
  const clipboard: Clipboard | undefined = navigator.clipboard
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    throw new ClipboardRefused('This browser will not let the page reach the clipboard.')
  }
  try {
    await clipboard.writeText(text)
  } catch (cause) {
    throw new ClipboardRefused('The browser refused to copy it.', { cause })
  }
}
