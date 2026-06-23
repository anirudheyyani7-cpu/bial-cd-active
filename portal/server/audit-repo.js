/**
 * Audit-trail data-access seam — one append-only, shared accountability source
 * (Decision 9; portable: documents now → a Postgres `audit_logs` table later).
 *
 * `createAuditRepo(collection)` records WHO did WHAT, especially deletes. ONE
 * append-only event per data MUTATION (create/update/delete) AND per admin
 * registry action (approve/reject/disable/config:loginRequired/clear-data/
 * app:delete) — the same source for both, because the user's requirement is "who
 * did what, especially deletes," and admin destructive actions are exactly that.
 *
 * Record CONTENTS are NEVER stored — only the actor, action, and the target ids
 * (collection / recordId) plus an optional affected `count` (e.g. clear-data).
 * Append-only: there is no update or delete. Each event is keyed by a generated
 * random `_id` (no natural key), mirroring feedback-repo.js. Every driver call is
 * wrapped in withThrottleRetry for Cosmos RU throttling (16500); like feedback,
 * the worst case under throttle is a dropped (un-logged) event, never a
 * double-write, because withThrottleRetry retries ONLY the pre-execution 16500.
 */
import { randomBytes } from 'node:crypto'
import { withThrottleRetry } from './mongo-retry.js'

/**
 * @param {object} collection - a Mongo collection handle (or a compatible fake)
 */
export function createAuditRepo(collection) {
  /**
   * Append one accountability event. The server owns `_id` + `at`; `username` is
   * the actor (an admin, an app user, or null for an anonymous open-app write).
   * Optional `collection`/`recordId`/`count` are included only when provided so a
   * data event and an admin event share one shape without storing empty fields.
   */
  async function record({ appId, username, action, collection: coll, recordId, count }) {
    const doc = {
      _id: randomBytes(16).toString('base64url'),
      appId,
      username: username ?? null,
      action,
      at: new Date().toISOString(),
    }
    if (coll !== undefined) doc.collection = coll
    if (recordId !== undefined) doc.recordId = recordId
    if (count !== undefined) doc.count = count
    return await withThrottleRetry(() => collection.insertOne(doc))
  }

  /** Newest-first events for one app, capped (default 200) to bound the RU scan. */
  async function listByApp(appId, { limit = 200 } = {}) {
    return await withThrottleRetry(() =>
      collection.find({ appId }).sort({ at: -1 }).limit(limit).toArray(),
    )
  }

  return { record, listByApp }
}
