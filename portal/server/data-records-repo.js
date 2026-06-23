/**
 * Generic, schemaless per-app record store — the tenant CHOKE-POINT (Decisions 1,
 * 2, 10; portable: documents now → Postgres `data_records` JSONB rows later).
 *
 * `createDataRecordsRepo(collection, registryRepo)` is the ONLY module that
 * touches `data_records`. EVERY method takes `appId` as its first parameter and
 * injects it into the Mongo filter, so a query that forgets the tenant scope is
 * structurally impossible to write — the BOLA (OWASP API1:2023) defence. Reads
 * and the destructive ops use a COMPOSITE `{ _id, appId }` filter (mirrors the
 * v1.3.0 `{ _id, username }` write-IDOR guard with username→appId), so a record
 * id guessed by app B never reads, mutates, or deletes app A's row.
 *
 * The store is schemaless ("store and return whatever an app sends") but NOT
 * unvalidated: the route runs `sanitizeData` ($/.-key + depth guard, reserved-
 * field stripping) and `sanitizeCollection` (name allowlist) — exported here and
 * shared — before handing CLEAN input to the repo, which then OWNS every reserved
 * field (`_id`, `appId`, `collection`, `createdBy`, `createdInDraft`, `bytes`,
 * timestamps) so client data can never spoof them.
 *
 * Quota is the v1.3.0 atomic conditional `$inc` (registryRepo.incData): insert
 * RESERVES `(+1, +bytes)` BEFORE writing and throws RecordQuotaError when over
 * cap (a failed insert compensates the reserve back); delete is a HARD
 * `deleteOne` that RELEASES `(-1, -bytes)` — symmetric, so create/delete churn
 * never silently exhausts the quota (Decision 10). Every driver call is wrapped
 * in withThrottleRetry for Cosmos RU throttling (16500).
 */
import { randomUUID } from 'node:crypto'
import { withThrottleRetry } from './mongo-retry.js'

// Reserved record fields the SERVER owns; stripped from any client `data` payload
// so a record body can never spoof the tenant scope, identity, or quota bytes.
const RESERVED_KEYS = new Set([
  '_id',
  'appId',
  'collection',
  'createdBy',
  'createdInDraft',
  'bytes',
  'createdAt',
  'updatedAt',
])

// Cap the nesting depth of a record so a pathological deep object can't blow the
// stack on serialize or smuggle operator-ish keys past a shallow check.
const MAX_DATA_DEPTH = 8
// Default per-list page cap (RU-bounded); a request may ask for less, never more.
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

const COLLECTION_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Thrown when an insert/update would exceed the per-app quota; the route maps it to 4xx. */
export class RecordQuotaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RecordQuotaError'
    this.code = 'RECORD_QUOTA_EXCEEDED'
  }
}

/** Recursively reject `$`/`.` object keys (NoSQL operator injection) + cap depth. */
function checkKeysAndDepth(value, depth) {
  if (depth > MAX_DATA_DEPTH) return 'record is nested too deeply'
  if (Array.isArray(value)) {
    for (const el of value) {
      const err = checkKeysAndDepth(el, depth + 1)
      if (err) return err
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.')) return `invalid field name: ${k}`
      const err = checkKeysAndDepth(v, depth + 1)
      if (err) return err
    }
  }
  return null
}

/**
 * Validate + clean a client `data` payload. Rejects a non-object, `$`/`.` keys at
 * any depth, and over-deep nesting; strips server-owned reserved keys so they are
 * ignored if sent. PURE; shared with the route (which maps !ok → 400).
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function sanitizeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'data must be a JSON object.' }
  }
  const depthErr = checkKeysAndDepth(data, 1)
  if (depthErr) return { ok: false, error: depthErr }
  const value = {}
  for (const [k, v] of Object.entries(data)) {
    if (!RESERVED_KEYS.has(k)) value[k] = v // reserved keys server-owned → ignored if sent
  }
  return { ok: true, value }
}

/**
 * Validate the app-chosen logical `collection` label. Absent → 'default' (the POC
 * single-collection default, Decision 1). PURE; shared with the route.
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
export function sanitizeCollection(name) {
  if (name === undefined || name === null) return { ok: true, value: 'default' }
  if (typeof name !== 'string' || !COLLECTION_RE.test(name)) {
    return { ok: false, error: 'collection must match ^[A-Za-z0-9_-]{1,64}$' }
  }
  return { ok: true, value: name }
}

/** UTF-8 byte size of a record's data (the quota unit). */
function byteSize(data) {
  return Buffer.byteLength(JSON.stringify(data ?? {}), 'utf8')
}

/**
 * @param {object} collection   - the `data_records` collection handle (or a fake)
 * @param {object} registryRepo - the app-registry repo (for the atomic quota counters)
 */
export function createDataRecordsRepo(collection, registryRepo) {
  /**
   * Insert one record into the caller's tenant. Reserves quota `(+1, +bytes)`
   * BEFORE writing (over-cap → RecordQuotaError, nothing inserted); a failed
   * insert compensates the reserve back so the counter never drifts up. `data`
   * is assumed already sanitized + `collection` already validated by the route;
   * the repo OWNS `_id`/`appId`/`bytes`/`createdInDraft`/timestamps.
   */
  async function insert({ appId, collection: coll, data, createdBy, createdInDraft }) {
    const bytes = byteSize(data)
    const reserved = await registryRepo.incData(appId, 1, bytes)
    if (!reserved) {
      throw new RecordQuotaError('This app has reached its data quota. Remove some records and try again.')
    }
    const now = new Date().toISOString()
    const doc = {
      _id: randomUUID(),
      appId, // tenant scope — from the verified app context, NEVER from the body
      collection: coll,
      data,
      createdBy: createdBy ?? null,
      createdInDraft: Boolean(createdInDraft),
      bytes,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await withThrottleRetry(() => collection.insertOne(doc))
    } catch (err) {
      await releaseQuota(appId, 1, bytes) // roll the reserve back so the cap doesn't drift
      throw err
    }
    return doc
  }

  /** Best-effort quota release (compensation / delete). Never throws. */
  async function releaseQuota(appId, dCount, dBytes) {
    try {
      await registryRepo.incData(appId, -dCount, -dBytes)
    } catch {
      // best-effort; a small positive drift is harmless and bounded.
    }
  }

  /** Newest-first records for one tenant, optionally filtered by collection. Capped. */
  async function list(appId, { collection: coll, limit = DEFAULT_LIST_LIMIT } = {}) {
    const filter = coll ? { appId, collection: coll } : { appId }
    const capped = Math.min(Math.max(1, Number(limit) || DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT)
    return await withThrottleRetry(() =>
      collection.find(filter).sort({ createdAt: -1 }).limit(capped).toArray(),
    )
  }

  /** Point-read one record in the caller's tenant (composite `{_id, appId}`). null on miss. */
  async function get(appId, id) {
    return await withThrottleRetry(() => collection.findOne({ _id: id, appId }))
  }

  /**
   * Shallow-merge `data` into an existing record the tenant owns (PATCH; last-
   * write-wins). Recomputes the byte size and adjusts the quota by the delta
   * (an increase over cap → RecordQuotaError). Returns the updated record, or
   * null when the record is absent / belongs to another tenant.
   */
  async function update(appId, id, data) {
    const existing = await get(appId, id)
    if (!existing) return null
    const merged = { ...(existing.data ?? {}), ...data }
    const newBytes = byteSize(merged)
    const delta = newBytes - (existing.bytes ?? 0)
    if (delta !== 0) {
      const adjusted = await registryRepo.incData(appId, 0, delta)
      if (!adjusted) {
        throw new RecordQuotaError('This app has reached its data quota. Remove some records and try again.')
      }
    }
    const now = new Date().toISOString()
    await withThrottleRetry(() =>
      collection.updateOne({ _id: id, appId }, { $set: { data: merged, bytes: newBytes, updatedAt: now } }),
    )
    return { ...existing, data: merged, bytes: newBytes, updatedAt: now }
  }

  /**
   * HARD-delete one record the tenant owns and RELEASE its quota `(-1, -bytes)`
   * — symmetric with insert, so create/delete churn never exhausts the quota
   * (Decision 10). Returns `{ deleted: boolean }`.
   */
  async function del(appId, id) {
    const existing = await get(appId, id)
    if (!existing) return { deleted: false }
    const res = await withThrottleRetry(() => collection.deleteOne({ _id: id, appId }))
    if ((res?.deletedCount ?? 0) > 0) await releaseQuota(appId, 1, existing.bytes ?? 0)
    return { deleted: (res?.deletedCount ?? 0) > 0 }
  }

  /**
   * Admin clear-data: hard-delete a tenant's records and reconcile the counters.
   * `createdInDraftOnly` removes only build-time test rows (and decrements by the
   * removed amount); a full purge removes everything and ZEROES the counters.
   * Returns `{ removed, bytes }` (the affected count, for the audit event).
   */
  async function purgeByApp(appId, { createdInDraftOnly = false } = {}) {
    const filter = createdInDraftOnly ? { appId, createdInDraft: true } : { appId }
    const doomed = await withThrottleRetry(() => collection.find(filter).limit(1_000_000).toArray())
    const removed = doomed.length
    const bytes = doomed.reduce((sum, d) => sum + (d.bytes ?? 0), 0)
    await withThrottleRetry(() => collection.deleteMany(filter))
    if (createdInDraftOnly) {
      if (removed > 0) await releaseQuota(appId, removed, bytes)
    } else {
      await registryRepo.setDataCounters(appId, { dataCount: 0, dataBytes: 0 })
    }
    return { removed, bytes }
  }

  return { insert, list, get, update, del, purgeByApp }
}
