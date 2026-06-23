/**
 * Per-message data-access seam (one document per message — never an unbounded
 * array on a growing header). Portable: documents now → a Postgres `messages`
 * table with a `parts JSONB` column later.
 *
 * `createMessagesRepo(collection)` wraps a Mongo collection (real or fake). A
 * message doc is `{ _id, conversationId, username, role, schemaVersion, parts[],
 * seq, createdAt }`. The repo persists `parts` opaquely (no per-element indexing)
 * and treats `seq` as a STORED sort key minted client-side (Decision 3) — it
 * never computes seq server-side, so inserts stay idempotent with no extra read
 * and a back-to-back user/assistant append can't race a server counter.
 *
 * THIN seam, scoped by `username` on every read/delete. Each driver call is
 * wrapped in withThrottleRetry (Cosmos RU throttle 16500). insertMessage is
 * idempotent on the client-minted `_id`: a duplicate-key error means the message
 * already landed (a retried POST), so it's treated as success rather than a 500.
 */
import { withThrottleRetry } from './mongo-retry.js'

/**
 * @param {object} collection - a Mongo collection handle (or a compatible fake)
 */
export function createMessagesRepo(collection) {
  /**
   * Persist one fully-built message doc (caller owns `_id`/`seq`/`createdAt`).
   * Idempotent: a duplicate `_id` (a retried insert of the same client-minted id)
   * resolves as success — the row is already there. withThrottleRetry retries ONLY
   * the pre-execution 16500 throttle (the insert never ran), so it can't combine
   * with the dup-key path to double-write.
   */
  async function insertMessage(doc) {
    try {
      return await withThrottleRetry(() => collection.insertOne(doc))
    } catch (err) {
      if (err?.code === 11000) return { acknowledged: true, insertedId: doc._id, duplicate: true }
      throw err
    }
  }

  /**
   * All messages of a conversation the caller owns, in stored `seq` order
   * (`createdAt` tiebreak). Scoped by BOTH conversationId AND username, so a
   * guessed conversationId from another user reads nothing. Capped to bound an
   * unbounded RU scan (a conversation won't approach the cap in the POC).
   *
   * The sort deliberately stops at `createdAt` — NO `_id` tiebreak. Azure Cosmos
   * DB for MongoDB accepts `_id` in a createIndex compound spec but will NOT use
   * that index to serve an ORDER BY containing `_id`, so a `{seq,createdAt,_id}`
   * sort 400s ("no corresponding composite index") even with the index present.
   * `seq` is the client-minted order and `createdAt` breaks the rare tie; a third
   * `_id` tiebreak was only defensive and is not worth an unservable query.
   */
  async function listByConversation(conversationId, username, { limit = 1000 } = {}) {
    return await withThrottleRetry(() =>
      collection
        .find({ conversationId, username })
        .sort({ seq: 1, createdAt: 1 })
        .limit(limit)
        .toArray(),
    )
  }

  /** Remove every message of a conversation the caller owns (on delete). */
  async function deleteByConversation(conversationId, username) {
    return await withThrottleRetry(() => collection.deleteMany({ conversationId, username }))
  }

  return { insertMessage, listByConversation, deleteByConversation }
}
