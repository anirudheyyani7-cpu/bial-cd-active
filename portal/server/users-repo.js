/**
 * User data-access seam.
 *
 * `createUsersRepo(collection)` wraps a Mongo collection (real or fake) so route
 * and seed logic is testable without a live Cosmos and the later FastAPI port is
 * mechanical. The refresh-token hash and its expiry are ALWAYS written and
 * cleared together — there is no code path that leaves a non-expiring token.
 *
 * Documents are keyed by `_id` = username, so every lookup is a single-document
 * point read and username uniqueness is enforced by Mongo's `_id` index for
 * free (no separate unique index to create or keep consistent).
 *
 * Each driver call is wrapped in withThrottleRetry so a transient Cosmos RU
 * throttle (error 16500) is retried rather than surfacing as a 500 — restoring
 * the resilience the Cosmos NoSQL SDK gave us for free. All ops are idempotent,
 * so retries are safe; the "matched no user" check stays OUTSIDE the retry.
 */
import { withThrottleRetry } from './mongo-retry.js'

/**
 * @param {object} collection - a Mongo collection handle (or a compatible fake)
 */
export function createUsersRepo(collection) {
  /** Point-read a user by username (= _id). null on miss. */
  async function findByUsername(username) {
    return await withThrottleRetry(() => collection.findOne({ _id: username }))
  }

  /** Set the refresh-token hash and its expiry together (single session). */
  async function setRefreshHash(username, hash, expiresAt) {
    // Build $set once so a retry reuses the same updatedAt (stays idempotent).
    const $set = { refreshTokenHash: hash, refreshTokenExpiresAt: expiresAt, updatedAt: new Date().toISOString() }
    const { matchedCount } = await withThrottleRetry(() => collection.updateOne({ _id: username }, { $set }))
    if (matchedCount === 0) throw new Error(`setRefreshHash matched no user: ${username}`)
  }

  /** Clear the refresh-token hash and its expiry together (revoke session). */
  async function clearRefreshHash(username) {
    const $set = { refreshTokenHash: null, refreshTokenExpiresAt: null, updatedAt: new Date().toISOString() }
    const { matchedCount } = await withThrottleRetry(() => collection.updateOne({ _id: username }, { $set }))
    if (matchedCount === 0) throw new Error(`clearRefreshHash matched no user: ${username}`)
  }

  /** Idempotent insert/replace keyed by `_id` (= username). */
  async function upsertUser(doc) {
    await withThrottleRetry(() => collection.replaceOne({ _id: doc._id }, doc, { upsert: true }))
    return doc
  }

  /**
   * List all users for the admin console. Projects OUT every secret/session
   * field (passwordHash + the refresh-token pair) so they can never leak to a
   * client — the admin UI only needs identity + limits. The user set is tiny
   * (interim auth), so an unfiltered scan is fine.
   */
  async function listUsers() {
    return await withThrottleRetry(() =>
      collection
        .find({}, { projection: { passwordHash: 0, refreshTokenHash: 0, refreshTokenExpiresAt: 0 } })
        .toArray(),
    )
  }

  /**
   * Apply an admin limit-override patch. A field set to a number is written to
   * `limits.<field>`; a field set to `null` is `$unset` (revert to the default).
   * Partial by design — only the provided fields change. Throws if no user
   * matched so a typo'd username surfaces as an error, not a silent no-op.
   */
  async function updateLimits(username, patch = {}) {
    const $set = { updatedAt: new Date().toISOString() }
    const $unset = {}
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) $unset[`limits.${field}`] = ''
      else $set[`limits.${field}`] = value
    }
    const update = Object.keys($unset).length ? { $set, $unset } : { $set }
    const { matchedCount } = await withThrottleRetry(() => collection.updateOne({ _id: username }, update))
    if (matchedCount === 0) throw new Error(`updateLimits matched no user: ${username}`)
  }

  return { findByUsername, setRefreshHash, clearRefreshHash, upsertUser, listUsers, updateLimits }
}
