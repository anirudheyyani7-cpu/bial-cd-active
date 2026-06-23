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
  '_search',
  'createdAt',
  'updatedAt',
])

// Cap the nesting depth of a record so a pathological deep object can't blow the
// stack on serialize or smuggle operator-ish keys past a shallow check.
const MAX_DATA_DEPTH = 8
// Default per-list page cap (RU-bounded); a request may ask for less, never more.
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500
// Search pagination defaults/caps (page-number paging; smaller page than list).
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
// Cap on the derived `_search` blob so a huge record can't bloat the index entry.
const MAX_SEARCH_BLOB = 8192
// Top-level (server-owned) fields a client may sort by; anything else is `data.<key>`.
const SORTABLE_TOP = new Set(['createdAt', 'updatedAt'])

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
 * Build the derived `_search` blob: a lowercased, space-joined concat of EVERY
 * scalar leaf in `data` (recursive, depth-capped, length-capped). Lets a single
 * escaped `$regex` match free-text across ALL fields of a schemaless record
 * without knowing its keys. Server-owned/reserved (a client can't set it) and
 * excluded from the quota `bytes` (it's derived, not user payload).
 */
export function buildSearchBlob(data) {
  const parts = []
  const walk = (value, depth) => {
    if (depth > MAX_DATA_DEPTH || value === null || value === undefined) return
    const t = typeof value
    if (t === 'string') parts.push(value.toLowerCase())
    else if (t === 'number' || t === 'boolean') parts.push(String(value).toLowerCase())
    else if (Array.isArray(value)) for (const el of value) walk(el, depth + 1)
    else if (t === 'object') for (const v of Object.values(value)) walk(v, depth + 1)
  }
  walk(data, 1)
  return parts.join(' ').slice(0, MAX_SEARCH_BLOB)
}

/** Escape user text so it's matched as a LITERAL substring (no regex injection / ReDoS). */
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Validate a single user-supplied field name (for distinct / sort). Rejects `$`/`.`
 * operator-ish keys and reserved server fields; PURE, shared with the route.
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
export function sanitizeFieldName(name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'field is required.' }
  if (name.startsWith('$') || name.includes('.') || RESERVED_KEYS.has(name)) {
    return { ok: false, error: `invalid field name: ${name}` }
  }
  return { ok: true, value: name }
}

/**
 * Resolve a client `sort` key to a SAFE Mongo path: the whitelisted top-level
 * timestamps, or `data.<field>` for an app's own field. PURE; shared with the route.
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
export function resolveSortPath(sort) {
  if (sort === undefined || sort === null || sort === '') return { ok: true, value: 'createdAt' }
  if (SORTABLE_TOP.has(sort)) return { ok: true, value: sort }
  const field = sanitizeFieldName(sort)
  if (!field.ok) return { ok: false, error: `invalid sort field: ${sort}` }
  return { ok: true, value: 'data.' + field.value }
}

/**
 * Turn a client `{ field: scalar }` object into sanitized `data.<field>` EQUALITY
 * pairs for a Mongo filter. Rejects `$`/`.`/reserved keys (operator injection) and
 * non-scalar values (no nested operators in the POC). PURE; shared with the route.
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function buildDataFilter(filterObj) {
  if (filterObj === undefined || filterObj === null) return { ok: true, value: {} }
  if (typeof filterObj !== 'object' || Array.isArray(filterObj)) {
    return { ok: false, error: 'filter must be a JSON object of field:value pairs.' }
  }
  const value = {}
  for (const [k, v] of Object.entries(filterObj)) {
    if (k.startsWith('$') || k.includes('.') || RESERVED_KEYS.has(k)) {
      return { ok: false, error: `invalid filter field: ${k}` }
    }
    if (v !== null && typeof v === 'object') {
      return { ok: false, error: `filter value for "${k}" must be a string, number, boolean, or null.` }
    }
    value['data.' + k] = v
  }
  return { ok: true, value }
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
      _search: buildSearchBlob(data), // derived: free-text search across all fields
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

  /**
   * Paged, generic SEARCH within one tenant. Free-text `q` matches across ALL
   * fields via the derived `_search` blob (escaped `$regex`, case-insensitive
   * contains); `dataFilter` is sanitized `data.<key>` equality pairs; `sortPath`
   * is a pre-resolved safe path. Returns `{ items, total, page, pageSize }`; the
   * route assembles `totalPages`. `appId` stays inside the filter (BOLA).
   */
  async function search(appId, { collection: coll, q, dataFilter, sortPath = 'createdAt', order, page, pageSize } = {}) {
    const filter = coll ? { appId, collection: coll } : { appId }
    if (dataFilter) Object.assign(filter, dataFilter)
    if (q) filter._search = { $regex: escapeRegex(String(q).toLowerCase()) }
    const safePageSize = Math.min(Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
    const safePage = Math.max(1, Number(page) || 1)
    // SINGLE-field sort only. This Azure Cosmos DB for MongoDB account serves just a
    // single-field ORDER BY — a multi-field sort like `{ sortPath, _id }` 400s even
    // with a matching composite index (same constraint that forced messages-repo to
    // sort by `seq` alone; see ensure-indexes.js). Unlike messages, records have no
    // unique monotonic per-tenant counter to tiebreak on, so when the sort key TIES
    // (e.g. bulk-seeded rows sharing a millisecond `createdAt`, or many rows sharing
    // a `data.<field>` value) skip/limit paging is NOT guaranteed stable across pages
    // under concurrent writes. Acceptable at POC scale; a per-tenant `seq` is the fix.
    const sortSpec = { [sortPath]: order === 'asc' ? 1 : -1 }
    const [items, total] = await Promise.all([
      withThrottleRetry(() =>
        collection.find(filter).sort(sortSpec).skip((safePage - 1) * safePageSize).limit(safePageSize).toArray(),
      ),
      withThrottleRetry(() => collection.countDocuments(filter)),
    ])
    return { items, total, page: safePage, pageSize: safePageSize }
  }

  /**
   * Distinct values of one app field (`data.<field>`) within the tenant — for
   * building filter dropdowns / status chips. `field` is assumed validated by the
   * route. Drops null/undefined so the UI gets a clean value set.
   */
  async function distinct(appId, { collection: coll, field }) {
    const filter = coll ? { appId, collection: coll } : { appId }
    const values = await withThrottleRetry(() => collection.distinct('data.' + field, filter))
    return (values || []).filter((v) => v !== null && v !== undefined)
  }

  /**
   * One-time backfill: populate `_search` on legacy records written before this
   * field existed. Idempotent — only touches docs missing `_search`, so re-running
   * is a no-op. Optionally scoped to one `appId`. Returns `{ updated }`.
   */
  async function backfillSearchDocs({ appId, batch = 500 } = {}) {
    const filter = appId ? { appId, _search: { $exists: false } } : { _search: { $exists: false } }
    let updated = 0
    // Each update removes a doc from the `$exists:false` set, so re-querying the
    // same filter walks the remainder; bounded by `batch` per round.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const docs = await withThrottleRetry(() => collection.find(filter).limit(batch).toArray())
      if (docs.length === 0) break
      for (const d of docs) {
        await withThrottleRetry(() =>
          collection.updateOne({ _id: d._id }, { $set: { _search: buildSearchBlob(d.data) } }),
        )
        updated++
      }
      if (docs.length < batch) break
    }
    return { updated }
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
    let res
    try {
      res = await withThrottleRetry(() =>
        collection.updateOne(
          { _id: id, appId },
          // recompute `_search` from the MERGED object (PATCH is a shallow merge),
          // so search stays consistent after partial updates.
          { $set: { data: merged, bytes: newBytes, _search: buildSearchBlob(merged), updatedAt: now } },
        ),
      )
    } catch (err) {
      if (delta !== 0) await releaseQuota(appId, 0, delta) // failed write → roll the reserve back (no drift)
      throw err
    }
    // The record vanished concurrently (a delete/purge landed between the read and
    // this write): the composite filter matched nothing, so roll the reserved delta
    // back and report the truth — null → the route 404s, with NO fabricated success
    // record and NO spurious audit event.
    if ((res?.matchedCount ?? 0) === 0) {
      if (delta !== 0) await releaseQuota(appId, 0, delta)
      return null
    }
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

  return { insert, list, search, distinct, backfillSearchDocs, get, update, del, purgeByApp }
}
