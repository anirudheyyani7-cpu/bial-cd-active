/**
 * Attachment-byte data-access seam: bytes live in the OBJECT STORE, the only
 * attachment metadata in the DB is a per-user running-byte counter
 * (`attachment_usage`, `_id` = username). NO bytes ever touch the metadata DB,
 * so the Cosmos→Postgres move leaves this layer untouched (Decision 4).
 *
 * `createAttachmentsRepo(objectStore, usageCollection)` — image/PDF bytes only
 * (text attachments are carried inline as a text part, never stored here). Object
 * keys are username-prefixed (`att/<username>/<attachmentId>`), so a key derived
 * from the authenticated username can only ever address the caller's namespace.
 *
 * Quota accounting is race-safe (fixes the carried non-atomic putAttachment race,
 * U4): the reserve is an ATOMIC conditional `findOneAndUpdate` that only matches
 * when there is room. We first ensure the counter doc exists (so the conditional
 * update can match it on the very first upload), then reserve. Splitting it this
 * way sidesteps the Mongo "conditional filter + upsert ⇒ E11000 on _id" gotcha
 * that would fire when the doc exists but the total is over the threshold.
 *
 * There is no transaction across the DB and the object store; a crash mid-op can
 * orphan an object or a counter increment. Best-effort compensation (decrement on
 * a failed put, decrement on delete) keeps drift bounded; an orphan-sweep is a
 * deferred follow-up. All counter ops are wrapped in withThrottleRetry.
 */
import { withThrottleRetry } from './mongo-retry.js'

// ~50 MB per-user running total (mirrors the retired client-side cap). Per user.
export const ATTACHMENT_TOTAL_CAP = 50 * 1024 * 1024

/** Thrown when a put would exceed the per-user total cap; the route maps it to 4xx. */
export class AttachmentCapError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AttachmentCapError'
    this.code = 'ATTACHMENT_STORE_FULL'
  }
}

/** Username-prefixed object key — the per-user namespace boundary. */
function keyFor(username, attachmentId) {
  return `att/${username}/${attachmentId}`
}

/**
 * @param {object} objectStore     - an ObjectStore (put/get/delete/exists) or fake
 * @param {object} usageCollection - the `attachment_usage` collection (or fake)
 */
export function createAttachmentsRepo(objectStore, usageCollection) {
  /** Best-effort counter decrement (compensation / delete). Never throws. */
  async function decrement(username, size) {
    if (!Number.isFinite(size) || size <= 0) return
    try {
      await withThrottleRetry(() =>
        usageCollection.updateOne({ _id: username }, { $inc: { total: -size }, $set: { updatedAt: new Date().toISOString() } }),
      )
    } catch {
      // best-effort; a small positive drift is harmless and bounded.
    }
  }

  /**
   * Reserve quota atomically, then store the bytes. Over-cap → AttachmentCapError
   * with nothing stored and no drift. A failed object-store put compensates the
   * reserve back. Returns the file-part ref `{attachmentId, key, mediaType, size, name}`.
   */
  async function putBytes({ attachmentId, username, mediaType, size, name, buffer }) {
    const now = new Date().toISOString()
    // Ensure the counter doc exists so the conditional reserve below can match it
    // on the user's first-ever upload (idempotent: no-op once present).
    await withThrottleRetry(() =>
      usageCollection.updateOne(
        { _id: username },
        { $setOnInsert: { total: 0, createdAt: now } },
        { upsert: true },
      ),
    )
    // Atomic reserve: only matches when there is room for `size`. A miss (null)
    // means the cap would be exceeded — nothing was incremented.
    const reserved = await withThrottleRetry(() =>
      usageCollection.findOneAndUpdate(
        { _id: username, total: { $lte: ATTACHMENT_TOTAL_CAP - size } },
        { $inc: { total: size }, $set: { updatedAt: now } },
        { returnDocument: 'after' },
      ),
    )
    if (!reserved) {
      throw new AttachmentCapError('Attachment storage is full. Remove some attachments and try again.')
    }

    const key = keyFor(username, attachmentId)
    try {
      await objectStore.put(key, buffer, mediaType)
    } catch (err) {
      await decrement(username, size) // roll the reserve back so the cap doesn't drift up
      throw err
    }
    return { attachmentId, key, mediaType, size, name }
  }

  /** Fetch an attachment's bytes from the caller's own namespace (Buffer). */
  async function getBytes(attachmentId, username) {
    return await objectStore.get(keyFor(username, attachmentId))
  }

  /** Delete one attachment object and (best-effort) decrement the total by `size`. */
  async function deleteBytes(attachmentId, username, size) {
    await objectStore.delete(keyFor(username, attachmentId))
    await decrement(username, size)
  }

  /**
   * Sweep a conversation's attachment objects on delete. `fileRefs` are the
   * conversation's file-part refs (`{attachmentId, size}`), gathered by the route
   * from the messages. Per-object delete is best-effort (a missing object is fine);
   * the total is decremented once by the summed size.
   */
  async function deleteByConversation(fileRefs, username) {
    if (!Array.isArray(fileRefs) || fileRefs.length === 0) return
    let freed = 0
    for (const ref of fileRefs) {
      try {
        await objectStore.delete(keyFor(username, ref.attachmentId))
        freed += Number(ref.size) || 0
      } catch {
        // best-effort per object; keep going so one failure doesn't strand the rest.
      }
    }
    await decrement(username, freed)
  }

  /** The user's running byte total (0 on miss). */
  async function getTotal(username) {
    const doc = await withThrottleRetry(() => usageCollection.findOne({ _id: username }))
    return doc?.total ?? 0
  }

  return { putBytes, getBytes, deleteBytes, deleteByConversation, getTotal }
}
