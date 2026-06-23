/**
 * Idempotent composite-index bootstrap for Azure Cosmos DB for MongoDB.
 *
 * Cosmos for MongoDB (RU) — unlike native MongoDB and unlike the local `mongo:7`
 * dev container — cannot serve a query that FILTERS on one field and SORTs (ORDER
 * BY) on another, or sorts on multiple fields, unless a COMPOSITE index spanning
 * exactly those fields exists. It rejects with BadRequest(400) "The order by query
 * does not have a corresponding composite index that it can be served from" rather
 * than doing an in-memory sort (so it works locally but 400s on a deployed Cosmos).
 * The collections are provisioned out-of-band (see cosmos.js) and nothing else
 * creates indexes, so this module supplies the indexes our filter+sort reads need.
 *
 * Each spec mirrors exactly ONE repo query — keep them in lockstep when a query's
 * filter or sort changes. The Cosmos rule: the equality-filter fields come first,
 * then EVERY ORDER BY field in the same sequence. A compound index also serves the
 * fully reversed sort, but NOT a different field order — so the kind-filtered and
 * the unfiltered conversation lists each need their own index (the documented
 * `{username,kind,updatedAt}` alone cannot serve `find({username}).sort(updatedAt)`,
 * which is why the unfiltered list 400s even when that index exists).
 *
 * `createIndex` is idempotent (a no-op when an identical index already exists), so
 * this runs safely on every boot and self-heals a fresh deployment. Index builds
 * are background + low-priority on Cosmos, so this never blocks reads. A single
 * index that fails to create is logged loudly and skipped rather than crashing the
 * whole server — the rest of the app still boots, and the log names exactly what to
 * fix.
 */
import { withThrottleRetry } from './mongo-retry.js'

/**
 * Required indexes grouped by the collection key passed in `collections`. Mirrors
 * the filter+sort reads in conversations-repo / messages-repo / feedback-repo.
 */
const INDEX_SPECS = {
  conversations: [
    // listByUser(username): newest-first across ALL kinds — `kind` must NOT sit
    // between the filter and the sort key, hence a dedicated 2-field index.
    { username: 1, updatedAt: -1 },
    // listByUser(username, kind): sidebar list filtered to one kind.
    { username: 1, kind: 1, updatedAt: -1 },
  ],
  messages: [
    // listByConversation(conversationId, username): owned messages in `seq` order.
    // Equality (conversationId, username) first, then the single `seq` sort key.
    // This Cosmos account serves only SINGLE-field ORDER BY — a multi-field sort
    // ({seq,createdAt} or {seq,createdAt,_id}) 400s even with a matching compound
    // index — and `seq` is a unique monotonic counter that fully orders messages on
    // its own, so the sort (and this index) stop at seq. Lockstep with messages-repo.
    { conversationId: 1, username: 1, seq: 1 },
  ],
  feedback: [
    // listFeedback(): newest-first with no filter — only `_id` is auto-indexed, so
    // the `createdAt` sort still needs its own index.
    { createdAt: -1 },
  ],
  dataRecords: [
    // data-records-repo list(appId) + search(appId, sort=createdAt): newest-first
    // across ALL collections for one tenant — `collection` must NOT sit between the
    // `appId` equality and the `createdAt` sort, so this 2-field index is dedicated.
    { appId: 1, createdAt: -1 },
    // list(appId, collection) + search(appId, collection, sort=createdAt).
    { appId: 1, collection: 1, createdAt: -1 },
    // search(appId, sort=updatedAt) — the other whitelisted top-level sort key.
    { appId: 1, updatedAt: -1 },
    // search(appId, collection, sort=updatedAt).
    { appId: 1, collection: 1, updatedAt: -1 },
  ],
  appFiles: [
    // app-files-repo list(appId): ready files newest-first across ALL collections
    // for one tenant — `collection` must NOT sit between the `appId` equality and the
    // `createdAt` sort, so this 2-field index is dedicated (mirrors dataRecords).
    { appId: 1, createdAt: -1 },
    // list(appId, collection): files in one logical collection, newest-first.
    { appId: 1, collection: 1, createdAt: -1 },
  ],
}

/**
 * Create every required index on the supplied collection handles. Idempotent and
 * resilient: each createIndex is retried on a transient RU throttle and, on any
 * other failure, logged and skipped so one bad index can't abort boot. A collection
 * key absent from `collections` is skipped (lets callers wire only what they have).
 *
 * @param {Record<string, import('mongodb').Collection>} collections
 *   map of spec key → collection handle, e.g. { conversations, messages, feedback }
 * @returns {Promise<{ created: number, failed: number }>}
 */
export async function ensureIndexes(collections) {
  let created = 0
  let failed = 0
  for (const [key, specs] of Object.entries(INDEX_SPECS)) {
    const collection = collections[key]
    if (!collection) continue // not wired on this deploy — skip
    for (const keyspec of specs) {
      try {
        await withThrottleRetry(() => collection.createIndex(keyspec))
        created += 1
      } catch (err) {
        failed += 1
        console.error(
          `ensureIndexes: FAILED to create index on "${key}" ${JSON.stringify(keyspec)}: ${err.message}`,
        )
      }
    }
  }
  if (failed > 0) {
    console.error(
      `ensureIndexes: ${created} index(es) ensured, ${failed} FAILED — filter+sort reads on the affected collections will 400 until fixed.`,
    )
  } else {
    console.log(`ensureIndexes: ${created} composite index(es) ensured.`)
  }
  return { created, failed }
}

/** Exposed for tests / the standalone script — the canonical index list. */
export { INDEX_SPECS }
