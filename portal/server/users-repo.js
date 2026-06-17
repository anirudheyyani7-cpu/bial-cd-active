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

  return { findByUsername, setRefreshHash, clearRefreshHash, upsertUser }
}
