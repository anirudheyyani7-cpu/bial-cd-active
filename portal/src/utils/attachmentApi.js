/**
 * Attachment byte access over the server object-store routes (replaces the
 * retired IndexedDB engine). Image/PDF bytes are uploaded once on send and
 * fetched lazily for display; text attachments are NEVER uploaded — their
 * content travels inline as a text part (see attachmentStore.js).
 *
 * Thin wrappers over /api/attachments via authFetch (Bearer + one 401-refresh
 * retry). Deps are injectable so the module is testable without a real network
 * or token, mirroring utils/admin.js.
 */
import { authFetch } from './api.js'

/** Thrown when an upload is rejected for the per-user storage cap; the UI catches it. */
export class AttachmentCapError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AttachmentCapError'
    this.code = 'ATTACHMENT_STORE_FULL'
  }
}

/**
 * Upload one image/PDF and return its file-part ref
 * `{ attachmentId, key, kind, name, mediaType, size }`. Text attachments must
 * NOT be passed here (they're inline). Throws AttachmentCapError when the
 * per-user cap is hit, else a generic Error with the server message.
 */
export async function uploadAttachment({ attachmentId, name, mediaType, size, base64 }, deps = {}) {
  const res = await authFetch(
    '/api/attachments',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentId, name, mediaType, size, base64 }),
    },
    deps,
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const message = body.error?.message || `Attachment upload failed (${res.status}).`
    if (body.error?.code === 'ATTACHMENT_STORE_FULL') throw new AttachmentCapError(message)
    throw new Error(message)
  }
  const data = await res.json()
  return data.attachment
}

// Module-level object-URL cache keyed by attachmentId: a second display of the
// same image reuses the URL instead of refetching the bytes. URLs are released
// at the session boundary (revokeAllAttachmentUrls on logout), not per chip
// unmount — a shared URL must outlive any single component that shows it.
const urlCache = new Map() // attachmentId -> resolved object URL
// In-flight fetches keyed by attachmentId so concurrent callers (StrictMode
// double-mount, or the same image shown in two chips) coalesce onto ONE request
// — without this, both pass the cache miss, both createObjectURL, and the first
// URL is orphaned (leaked, never revoked) while a redundant GET is issued.
const pendingFetches = new Map() // attachmentId -> Promise<string|null>

/**
 * Fetch an attachment's bytes and return a cached object URL (or null if the
 * object is gone / forbidden). The second call for the same id returns the
 * cached URL without a network round-trip; concurrent calls share one fetch.
 */
export async function fetchAttachmentObjectUrl(attachmentId, deps = {}) {
  if (urlCache.has(attachmentId)) return urlCache.get(attachmentId)
  if (pendingFetches.has(attachmentId)) return pendingFetches.get(attachmentId)
  const p = (async () => {
    const res = await authFetch(`/api/attachments/${encodeURIComponent(attachmentId)}`, {}, deps)
    if (!res.ok) return null
    const url = URL.createObjectURL(await res.blob())
    urlCache.set(attachmentId, url)
    return url
  })().finally(() => pendingFetches.delete(attachmentId))
  pendingFetches.set(attachmentId, p)
  return p
}

/** Release one cached object URL (revokes + drops it so the next fetch refetches). */
export function revokeAttachmentObjectUrl(attachmentId) {
  const url = urlCache.get(attachmentId)
  if (url) {
    URL.revokeObjectURL(url)
    urlCache.delete(attachmentId)
  }
}

/** Release every cached object URL (session teardown / logout). */
export function revokeAllAttachmentUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
}

/** Delete one attachment object (best-effort) and drop its cached URL. */
export async function deleteAttachment(attachmentId, deps = {}) {
  try {
    await authFetch(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }, deps)
  } catch {
    // best-effort; the conversation-delete sweep is the authoritative cleanup.
  }
  revokeAttachmentObjectUrl(attachmentId)
}
