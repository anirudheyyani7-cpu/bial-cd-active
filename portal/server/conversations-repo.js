/**
 * Conversation-header data-access seam (portable: documents now → Postgres rows
 * later).
 *
 * `createConversationsRepo(collection)` wraps a Mongo collection (real or fake)
 * so the conversation/message routes are testable without a live Cosmos and the
 * later Postgres port is mechanical. A conversation HEADER is one lightweight doc
 * per conversation (chat or builder); the per-message bodies live in
 * messages-repo.js. The builder's generated code rides on the header as
 * `code.current` (a single snapshot — no history; Decision 2).
 *
 * THIN seam: the caller (route) owns identity (`_id`, `username`, `kind`) and
 * builds the doc; the repo only persists/reads, scoping EVERY operation by
 * `username` so a guessed/colliding `_id` can never read, patch, or overwrite
 * another user's header. Each driver call is wrapped in withThrottleRetry so a
 * transient Cosmos RU throttle (16500) is retried, not surfaced as a 500.
 *
 * Why upsertHeader uses $set/$setOnInsert (not replaceOne): the route upserts the
 * header on EVERY message append (so an assistant turn never references a
 * header-less conversation). A whole-document replace would wipe `code.current`
 * and `createdAt` on each append; a field-merge upsert touches only the fields a
 * given call supplies and leaves the builder's code + creation time intact. The
 * `{ _id, username }` filter still closes the write-IDOR: a cross-user `_id`
 * collision matches no doc, so the upsert attempts an INSERT that the unique `_id`
 * index rejects (E11000) — never a silent overwrite of another user's header.
 */
import { withThrottleRetry } from './mongo-retry.js'

/**
 * @param {object} collection - a Mongo collection handle (or a compatible fake)
 */
export function createConversationsRepo(collection) {
  /**
   * Idempotent upsert of a conversation header, scoped by `{ _id, username }`.
   * `header` carries `_id`, `username`, `kind` and optional `title`/`context`/
   * `createdAt`. Immutable-on-insert fields (`kind`, `createdAt`) go to
   * $setOnInsert; mutable fields (`title`, `context`, `updatedAt`) to $set, so a
   * later append-time upsert never clobbers them or the builder's `code.current`.
   */
  async function upsertHeader(header) {
    const { _id, username, kind, title, context, createdAt, updatedAt } = header
    const now = new Date().toISOString()
    const set = { updatedAt: updatedAt || now }
    if (title !== undefined) set.title = title
    if (context !== undefined) set.context = context
    const setOnInsert = { kind, createdAt: createdAt || now }
    return await withThrottleRetry(() =>
      collection.updateOne(
        { _id, username },
        { $set: set, $setOnInsert: setOnInsert },
        { upsert: true },
      ),
    )
  }

  /** Newest-first headers for a user, optionally filtered by `kind`. Capped. */
  async function listByUser(username, kind, { limit = 200 } = {}) {
    const filter = kind ? { username, kind } : { username }
    return await withThrottleRetry(() =>
      collection.find(filter).sort({ updatedAt: -1 }).limit(limit).toArray(),
    )
  }

  /** Point-read one header owned by `username`. null on miss / wrong owner. */
  async function getHeader(_id, username) {
    return await withThrottleRetry(() => collection.findOne({ _id, username }))
  }

  /**
   * Set the builder's generated code snapshot (`code.current`) on a header the
   * caller owns. A cross-user `_id` matches nothing and patches nothing.
   */
  async function patchCode(_id, username, codeCurrent) {
    return await withThrottleRetry(() =>
      collection.updateOne(
        { _id, username },
        { $set: { 'code.current': codeCurrent, updatedAt: new Date().toISOString() } },
      ),
    )
  }

  /** Bump `updatedAt` on a header the caller owns (sidebar recency). */
  async function touch(_id, username) {
    return await withThrottleRetry(() =>
      collection.updateOne({ _id, username }, { $set: { updatedAt: new Date().toISOString() } }),
    )
  }

  /** Delete one header owned by `username` (messages/bytes swept by the route). */
  async function deleteHeader(_id, username) {
    return await withThrottleRetry(() => collection.deleteOne({ _id, username }))
  }

  return { upsertHeader, listByUser, getHeader, patchCode, touch, deleteHeader }
}
