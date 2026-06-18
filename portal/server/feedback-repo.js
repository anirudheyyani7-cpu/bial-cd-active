/**
 * User-feedback data-access seam.
 *
 * `createFeedbackRepo(collection)` wraps a Mongo collection (real or fake) so the
 * feedback write/read endpoints are testable without a live Cosmos and the later
 * FastAPI port is mechanical. This is a THIN persistence seam: the caller (the
 * route) builds the full document — including the generated `_id` and ISO
 * `createdAt` — so identity and validation stay together in the route, and the
 * repo only persists/reads. Feedback rows are append-only with no natural dedupe
 * key.
 *
 * Each driver call is wrapped in withThrottleRetry so a transient Cosmos RU
 * throttle (16500) is retried rather than surfacing as a 500. addFeedback is safe
 * under that retry NOT because insertOne is inherently idempotent, but because
 * withThrottleRetry retries ONLY the pre-execution 16500 rejection (the insert
 * never ran); any other error — including a lost-ack write under the required
 * retrywrites=false — propagates and is surfaced as a 500, so the worst case is a
 * dropped submission (the user retries), never an automatic double-write. See
 * usage-repo.js#addUsage for the same reasoning. Because feedback has no
 * idempotency key to fall back on, the retry predicate must NOT be widened to
 * cover transient network errors for this repo without first adding a dedupe key.
 */
import { withThrottleRetry } from './mongo-retry.js'

/**
 * @param {object} collection - a Mongo collection handle (or a compatible fake)
 */
export function createFeedbackRepo(collection) {
  /** Persist one fully-built feedback document (caller owns `_id` + `createdAt`). */
  async function addFeedback(doc) {
    return await withThrottleRetry(() => collection.insertOne(doc))
  }

  /** Newest-first list, capped (default 200) to bound an unbounded RU scan. */
  async function listFeedback({ limit = 200 } = {}) {
    return await withThrottleRetry(() =>
      collection.find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
    )
  }

  /** True total count, independent of the list cap (drives "newest 200 of N"). */
  async function countFeedback() {
    return await withThrottleRetry(() => collection.countDocuments({}))
  }

  return { addFeedback, listFeedback, countFeedback }
}
