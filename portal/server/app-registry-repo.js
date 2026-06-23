/**
 * App Registry data-access seam (portable: documents now → Postgres rows later).
 *
 * `createAppRegistryRepo(collection)` wraps a Mongo collection (real or fake) so
 * the provision/deploy/admin routes are testable without a live Cosmos and the
 * later Postgres port is mechanical. ONE doc per generated app, keyed by
 * `_id` = appId (= the builder conversation uuid, a clean 1:1 build↔app mapping).
 *
 * The doc carries the app identity (`appKey` — a PUBLISHABLE scoping label, NOT a
 * secret; the Stripe publishable-key model), the live `loginRequired` guard
 * (Decision 5: resolved server-side on every request, never trusted from client/
 * token), the deploy `status` state machine (Decision 7), the code snapshots
 * (`code.source` = latest submitted, `code.approvedSnapshot` = last admin-
 * approved + server-pre-compiled), the pinned `dataSchema` (Decision 11), and the
 * per-app `dataCount`/`dataBytes` quota counters (Decision 10, origin doc §4.1
 * flood protection).
 *
 * Every driver call is wrapped in withThrottleRetry so a transient Cosmos RU
 * throttle (16500) is retried rather than surfacing as a 500. The status machine
 * is enforced with an ATOMIC conditional filter (`status: { $in: allowedFrom }`),
 * so an illegal transition simply matches nothing — no read-then-write race. The
 * quota reserve mirrors the v1.3.0 attachment-counter pattern: a conditional
 * `findOneAndUpdate` that only matches when there is room, with the SAME filter
 * serving release (a decrement raises the threshold, so it always matches).
 *
 * `rotateKey` is intentionally OMITTED — the `disabled` status is the kill-switch
 * (Deferred Follow-Up); key rotation has no consumer in the POC.
 */
import { randomBytes } from 'node:crypto'
import { withThrottleRetry } from './mongo-retry.js'

// Per-app volume ceilings (origin doc §4.1 flood protection). POC-sized; bound
// the total a single generated app can persist so one app can't exhaust the
// shared account's RU/storage. Exported so the data-records repo + tests share
// the exact thresholds.
export const APP_RECORD_COUNT_CAP = 50_000
export const APP_DATA_BYTES_CAP = 100 * 1024 * 1024 // 100 MB per app

// Bound an app name (advisory display label).
export const MAX_APP_NAME = 120

// The deploy state machine (Decision 7). Each target status lists the statuses it
// may be entered FROM; a transition not in this map matches nothing (atomic
// guard). Note `pending` is reachable from `approved` (a re-submit returns an
// approved app to pending while the runner keeps serving the prior snapshot) and
// from `rejected` (resubmit). `draft` is created only by ensureDraft, never a
// transition target.
const ALLOWED_FROM = {
  pending: ['draft', 'rejected', 'approved'],
  approved: ['pending', 'disabled'],
  rejected: ['pending'],
  disabled: ['approved'],
}
export const APP_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'disabled']

/** Mint a publishable, non-secret app key (a scoping label, not authentication). */
function mintAppKey() {
  return `bial_${randomBytes(24).toString('base64url')}`
}

/**
 * Validate an app-registration patch body (provision/patch). PURE function
 * mirroring feedback.js#validateFeedback. `name` (if present) must be a bounded
 * string; `loginRequired` (if present) must be a boolean. Both optional so the
 * caller can send a sparse patch.
 * @returns {{ok:true, value:{name?:string, loginRequired?:boolean}} | {ok:false, error:string}}
 */
export function validateAppRegistration(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid app registration body.' }
  }
  const value = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return { ok: false, error: 'name must be a string.' }
    const name = body.name.trim()
    if (name.length > MAX_APP_NAME) return { ok: false, error: `name is too long (max ${MAX_APP_NAME} characters).` }
    value.name = name
  }
  if (body.loginRequired !== undefined) {
    if (typeof body.loginRequired !== 'boolean') return { ok: false, error: 'loginRequired must be a boolean.' }
    value.loginRequired = body.loginRequired
  }
  return { ok: true, value }
}

/**
 * @param {object} collection - a Mongo collection handle (or a compatible fake)
 */
export function createAppRegistryRepo(collection) {
  /**
   * Idempotent upsert of a DRAFT app doc, scoped by `{ _id: appId }`. The appKey,
   * status, owner, counters and createdAt go to $setOnInsert so calling this
   * repeatedly NEVER re-mints the key or clobbers the doc — the build-time
   * provision, the submit ensure-draft, and any retry all converge on one draft.
   * Returns the resolved doc (after).
   */
  async function ensureDraft(appId, ownerUsername) {
    const now = new Date().toISOString()
    return await withThrottleRetry(() =>
      collection.findOneAndUpdate(
        { _id: appId },
        {
          $setOnInsert: {
            appKey: mintAppKey(),
            ownerUsername,
            name: '',
            loginRequired: false, // admin owns this; set deliberately at approval (Decision 5)
            status: 'draft',
            dataCount: 0,
            dataBytes: 0,
            createdAt: now,
          },
          $set: { updatedAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      ),
    )
  }

  /** Point-read one app by id. null on miss. */
  async function getApp(appId) {
    return await withThrottleRetry(() => collection.findOne({ _id: appId }))
  }

  /** Point-read one app by its app key (the runtime's identity resolution). null on miss. */
  async function getByKey(appKey) {
    return await withThrottleRetry(() => collection.findOne({ appKey }))
  }

  /** Newest-first apps, optionally filtered by status. Capped to bound the scan. */
  async function listApps({ status, limit = 200 } = {}) {
    const filter = status ? { status } : {}
    return await withThrottleRetry(() =>
      collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray(),
    )
  }

  /**
   * Move an app to `status`, enforcing the allowed-transition machine ATOMICALLY:
   * the filter only matches when the current status is a legal predecessor, so an
   * illegal transition (e.g. approved→approved, draft→approved) simply matches
   * nothing. `meta` (e.g. { approvedBy, approvedAt, note }) is merged into $set.
   * @returns {{ ok: boolean }} — ok:false means not-found OR illegal transition;
   *   the caller distinguishes via a prior getApp (404 vs 409).
   */
  async function setStatus(appId, status, meta = {}) {
    const allowedFrom = ALLOWED_FROM[status]
    if (!allowedFrom) throw new Error(`Unknown target status: ${status}`)
    const res = await withThrottleRetry(() =>
      collection.updateOne(
        { _id: appId, status: { $in: allowedFrom } },
        // meta spread BEFORE status so a stray meta.status can never override the
        // validated transition target (meta only carries approvedBy/at, rejectionNote).
        { $set: { ...meta, status, updatedAt: new Date().toISOString() } },
      ),
    )
    return { ok: (res?.matchedCount ?? 0) > 0 }
  }

  /**
   * Write the code snapshots independently. `source` updates `code.source` (latest
   * submitted) and `approvedSnapshot` updates `code.approvedSnapshot` (last
   * admin-approved); a dotted $set on one leaves the other untouched.
   */
  async function setSnapshots(appId, { source, approvedSnapshot } = {}) {
    const set = { updatedAt: new Date().toISOString() }
    if (source !== undefined) set['code.source'] = source
    if (approvedSnapshot !== undefined) set['code.approvedSnapshot'] = approvedSnapshot
    return await withThrottleRetry(() => collection.updateOne({ _id: appId }, { $set: set }))
  }

  /**
   * Patch mutable, non-identity fields (name / loginRequired / dataSchema). NEVER
   * touches appKey or status — those move only via ensureDraft/setStatus.
   */
  async function patchApp(appId, { name, loginRequired, dataSchema } = {}) {
    const set = { updatedAt: new Date().toISOString() }
    if (name !== undefined) set.name = name
    if (loginRequired !== undefined) set.loginRequired = loginRequired
    if (dataSchema !== undefined) set.dataSchema = dataSchema
    return await withThrottleRetry(() => collection.updateOne({ _id: appId }, { $set: set }))
  }

  /**
   * Atomically adjust the per-app quota counters. Increment (positive) is a
   * CONDITIONAL reserve — it only matches when both counters have room for the
   * delta, so an over-quota insert returns null with nothing incremented (no
   * read-then-write race). Decrement (negative) uses the SAME filter: subtracting
   * raises the `$lte` threshold above the current value, so a release always
   * matches. Returns the updated doc, or null when an increment would exceed a
   * cap (or the app is missing).
   */
  async function incData(appId, dCount, dBytes) {
    return await withThrottleRetry(() =>
      collection.findOneAndUpdate(
        {
          _id: appId,
          dataCount: { $lte: APP_RECORD_COUNT_CAP - dCount },
          dataBytes: { $lte: APP_DATA_BYTES_CAP - dBytes },
        },
        { $inc: { dataCount: dCount, dataBytes: dBytes }, $set: { updatedAt: new Date().toISOString() } },
        { returnDocument: 'after' },
      ),
    )
  }

  /** Reset the quota counters to an exact pair (admin clear-data reconciliation). */
  async function setDataCounters(appId, { dataCount, dataBytes }) {
    return await withThrottleRetry(() =>
      collection.updateOne(
        { _id: appId },
        { $set: { dataCount, dataBytes, updatedAt: new Date().toISOString() } },
      ),
    )
  }

  /** Hard-delete the registry doc (admin app deletion; data/audit swept by the route). */
  async function deleteApp(appId) {
    return await withThrottleRetry(() => collection.deleteOne({ _id: appId }))
  }

  return {
    ensureDraft,
    getApp,
    getByKey,
    listApps,
    setStatus,
    setSnapshots,
    patchApp,
    incData,
    setDataCounters,
    deleteApp,
  }
}
