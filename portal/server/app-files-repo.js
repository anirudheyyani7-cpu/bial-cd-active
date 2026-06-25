/**
 * Per-app FILE metadata store — the file-side twin of data-records-repo (Decisions
 * 1, 6, 7, 8; portable: documents now → Postgres `app_files` rows + an object store
 * later). The bytes live in the ObjectStore; ONLY the metadata + a `pending|ready`
 * status live here, so files are listable / quota'd / lifecycle-managed alongside
 * records without ever putting bytes on the RU budget.
 *
 * `createAppFilesRepo(collection, registryRepo)` is the ONLY module that touches
 * `app_files`. EVERY method takes `appId` and injects it into the Mongo filter, so a
 * tenant-scope-forgetting query is structurally impossible (BOLA / OWASP API1:2023);
 * reads + destructive ops use a COMPOSITE `{ _id, appId }` filter, so a fileId guessed
 * by app B never reaches app A's file.
 *
 * Two-store integrity (Cosmos + the object store share no transaction) is ORDERED +
 * STATUS-GATED so no unreachable blob and no listable-broken file can arise:
 *   UPLOAD  (route): reserve quota → insert metadata `pending` → put blob → markReady.
 *           App-facing reads (list/get) filter to `ready`, so a not-yet-uploaded file
 *           is never listable. A put failure deletes the pending row + releases the
 *           reserve (no unreachable blob — the blob was never written). A crash before
 *           markReady leaves a stale `pending` row (invisible to apps), reclaimed by
 *           the admin recompute (metadata-only — no object-store enumeration).
 *   DELETE  (route): delete blob (idempotent) → del metadata → release quota.
 * The only residual is bounded, upward-safe counter drift, reconciled by `recompute`.
 *
 * The file-type validator (sanitizeFilename/sanitizeCollection/assertContentType/
 * sniffMagic) lives HERE — it deliberately does NOT extend message-content.js's
 * ALLOWED_MEDIA, which sits on the /api/claude + attachment trust boundary; the
 * allowlists may overlap but the validators stay separate to keep the boundaries
 * distinct. SVG is intentionally excluded (script-execution vector, not reliably
 * magic-validatable).
 */
import { randomUUID } from 'node:crypto'
import { withThrottleRetry } from './mongo-retry.js'
import { APP_FILE_COUNT_CAP } from './app-registry-repo.js'
import { sanitizeCollection } from './app-validators.js'

// Re-export so existing consumers/tests that import sanitizeCollection from this repo
// keep working; the definition now lives in app-validators.js (shared with records).
export { sanitizeCollection }

const FILENAME_RE = /^[A-Za-z0-9._-]{1,200}$/ // no quotes/CRLF/`;` → also blocks Content-Disposition injection
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500
// A `pending` row older than this with no matching `ready` is a crashed upload;
// the admin recompute sweeps it (metadata-only). Generous so a slow upload is safe.
const STALE_PENDING_MS = 60 * 60 * 1000 // 1 hour

/**
 * Default upload content-type allowlist (env APP_FILE_ALLOWED_TYPES overrides with a
 * comma-separated list). `image/svg+xml` is intentionally ABSENT. Mirrors the plan's
 * csv/xlsx/xls/json/txt/pdf/png/jpeg/gif/webp set.
 */
const DEFAULT_ALLOWED_TYPES = [
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx (PK zip; parsed by mammoth in a worker, like xlsx)
  'application/json',
  'text/plain',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

/**
 * Magic-byte prefixes for the content-types we CAN reliably sniff. Anything not here
 * (xls/csv/txt/json) is validated by declared content-type + size only — recorded
 * honestly rather than claiming false assurance. WebP is RIFF + a "WEBP" form-type at
 * offset 8 (checked separately); xlsx is the zip signature `PK\x03\x04`. `.xls`
 * (OLE2 `D0CF11E0…`) is deliberately omitted — its magic also matches `.doc`/`.ppt`.
 */
const MAGIC = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF (+ WEBP@8)
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04 (zip)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [0x50, 0x4b, 0x03, 0x04], // docx is also a PK zip; office-extract validates the real structure at parse time
}

/** Thrown when an insert would exceed the per-app file quota; the route maps it to 413. */
export class FileQuotaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FileQuotaError'
    this.code = 'FILE_QUOTA_EXCEEDED'
  }
}

/** Resolve the configured content-type allowlist (env override → default). */
function allowedTypes() {
  const raw = process.env.APP_FILE_ALLOWED_TYPES
  if (typeof raw === 'string' && raw.trim() !== '') {
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  }
  return new Set(DEFAULT_ALLOWED_TYPES)
}

/**
 * Validate an app-supplied filename. Strict allowlist regex (letters/digits/`._-`,
 * 1–200 chars) — rejects path separators, quotes, CRLF and `;`, so it can't smuggle
 * a `../` traversal into the object key OR a header injection into a download
 * disposition. PURE; shared with the route.
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
export function sanitizeFilename(name) {
  if (typeof name !== 'string' || !FILENAME_RE.test(name)) {
    return { ok: false, error: 'filename must match ^[A-Za-z0-9._-]{1,200}$' }
  }
  return { ok: true, value: name }
}

/**
 * Validate a declared upload content-type against the allowlist. `image/svg+xml` is
 * excluded by construction (not in DEFAULT_ALLOWED_TYPES). PURE; shared with the route.
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
export function assertContentType(contentType) {
  if (typeof contentType !== 'string' || contentType.length === 0) {
    return { ok: false, error: 'contentType is required.' }
  }
  if (!allowedTypes().has(contentType)) {
    return { ok: false, error: `Unsupported file type: ${contentType}.` }
  }
  return { ok: true, value: contentType }
}

/**
 * Sniff the magic bytes for the content-types that have a reliable signature
 * (images/pdf/xlsx-zip). For declared-type-only types (xls/csv/txt/json) there is no
 * magic, so this returns ok (declared-type + size are the only check, recorded
 * honestly). Rejects a declared image/pdf/xlsx whose bytes don't match. PURE.
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function sniffMagic(contentType, buffer) {
  const magic = MAGIC[contentType]
  if (!magic) return { ok: true } // no reliable magic — declared-type-only
  if (!buffer || buffer.length < magic.length || !magic.every((b, i) => buffer[i] === b)) {
    return { ok: false, error: `File bytes do not match the declared type ${contentType}.` }
  }
  // WebP's leading "RIFF" also matches WAV/AVI — require the "WEBP" form-type at offset 8.
  if (contentType === 'image/webp' && buffer.toString('latin1', 8, 12) !== 'WEBP') {
    return { ok: false, error: 'File bytes do not match the declared type image/webp.' }
  }
  return { ok: true }
}

/**
 * Reverse-sniff the IMAGE media type of stored bytes from their magic number (or null
 * when not a recognized image). The `/content` proxy serves this SNIFFED type for
 * images (mirrors attachments.js) so a mistyped upload can't drive a content-type
 * confusion; non-images are served as octet-stream + attachment regardless.
 */
export function sniffImageType(buffer) {
  if (!buffer || buffer.length === 0) return null
  for (const [type, magic] of Object.entries(MAGIC)) {
    if (!type.startsWith('image/')) continue
    if (buffer.length < magic.length || !magic.every((b, i) => buffer[i] === b)) continue
    if (type === 'image/webp' && buffer.toString('latin1', 8, 12) !== 'WEBP') continue
    return type
  }
  return null
}

/**
 * @param {object} collection   - the `app_files` collection handle (or a fake)
 * @param {object} registryRepo - the app-registry repo (for the atomic file-quota counters)
 */
export function createAppFilesRepo(collection, registryRepo) {
  /** Best-effort file-quota release (compensation / delete). Never throws. */
  async function releaseQuota(appId, dCount, dBytes) {
    try {
      await registryRepo.incFiles(appId, -dCount, -dBytes)
    } catch {
      // best-effort; a small positive drift is harmless, bounded, and recompute-able.
    }
  }

  /**
   * Insert one file's metadata in the `pending` state and RESERVE its quota
   * `(+1, +size)` BEFORE the route writes the blob (over-cap → FileQuotaError, nothing
   * inserted). The repo OWNS `_id` (= fileId), `blobKey` (= `apps/<appId>/<fileId>`,
   * prefix from the VERIFIED appId, never the body), `status`, `appId`, timestamps. A
   * failed metadata insert compensates the reserve back. Filename/collection/
   * contentType/size are assumed already validated by the route.
   */
  async function insert({ appId, collection: coll, filename, contentType, size, createdBy, createdInDraft }) {
    const reserved = await registryRepo.incFiles(appId, 1, size)
    if (!reserved) {
      throw new FileQuotaError('This app has reached its file storage quota. Remove some files and try again.')
    }
    const now = new Date().toISOString()
    const _id = randomUUID()
    const doc = {
      _id, // fileId
      appId, // tenant scope — from the verified app context, NEVER from the body
      collection: coll,
      filename,
      contentType,
      size,
      blobKey: `apps/${appId}/${_id}`, // server-minted key; appId-prefixed for object-layer isolation
      status: 'pending', // app-facing reads filter to `ready` until the blob is written
      createdBy: createdBy ?? null,
      createdInDraft: Boolean(createdInDraft),
      createdAt: now,
      updatedAt: now,
    }
    try {
      await withThrottleRetry(() => collection.insertOne(doc))
    } catch (err) {
      await releaseQuota(appId, 1, size) // roll the reserve back so the cap doesn't drift
      throw err
    }
    return doc
  }

  /** Flip a pending file to `ready` once its blob is written. Composite `{_id, appId}`. */
  async function markReady(appId, fileId) {
    return await withThrottleRetry(() =>
      collection.updateOne(
        { _id: fileId, appId },
        { $set: { status: 'ready', updatedAt: new Date().toISOString() } },
      ),
    )
  }

  /** Newest-first READY files for one tenant, optionally filtered by collection. Capped. */
  async function list(appId, { collection: coll, limit = DEFAULT_LIST_LIMIT } = {}) {
    const filter = coll ? { appId, collection: coll, status: 'ready' } : { appId, status: 'ready' }
    const capped = Math.min(Math.max(1, Number(limit) || DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT)
    return await withThrottleRetry(() =>
      // SINGLE-field sort (Cosmos for MongoDB serves only single-field ORDER BY); the
      // POC "not stable under ties" paging caveat is shared with records.
      collection.find(filter).sort({ createdAt: -1 }).limit(capped).toArray(),
    )
  }

  /**
   * Point-read one file in the caller's tenant (composite `{_id, appId}`). App-facing
   * reads require `ready`; admin/lifecycle reads pass `includePending` to also see a
   * not-yet-uploaded (or crashed) row. null on miss / wrong tenant / not-ready.
   */
  async function get(appId, fileId, { includePending = false } = {}) {
    const filter = includePending ? { _id: fileId, appId } : { _id: fileId, appId, status: 'ready' }
    return await withThrottleRetry(() => collection.findOne(filter))
  }

  /**
   * HARD-delete one file's metadata the tenant owns and RELEASE its quota
   * `(-1, -size)`. Reads with `includePending` so it also cleans up a pending row
   * (the upload-failure compensation path). The ROUTE deletes the blob FIRST, then
   * calls this, so quota is released only after both stores have been addressed.
   * Returns `{ deleted, blobKey, size }`.
   *
   * `opts.existing` lets a caller that ALREADY read the metadata (the DELETE route
   * resolves it to delete the blob first) pass it through, skipping the redundant
   * internal re-get. It is still composite-`{_id, appId}`-scoped, so a stale/foreign
   * doc can't be smuggled in: it must match the same appId, and deleteOne re-filters.
   */
  async function del(appId, fileId, { existing: provided } = {}) {
    const existing =
      provided && provided._id === fileId && provided.appId === appId
        ? provided
        : await get(appId, fileId, { includePending: true })
    if (!existing) return { deleted: false }
    const res = await withThrottleRetry(() => collection.deleteOne({ _id: fileId, appId }))
    const deleted = (res?.deletedCount ?? 0) > 0
    if (deleted) await releaseQuota(appId, 1, existing.size ?? 0)
    return { deleted, blobKey: existing.blobKey, size: existing.size ?? 0 }
  }

  /**
   * Admin clear-files: hard-delete a tenant's file METADATA and reconcile the
   * counters, returning the `{ fileId, blobKey }` list so the route can delete the
   * blobs (the repo never touches the object store). `createdInDraftOnly` removes
   * only build-time files (and decrements by the removed amount); a full purge
   * removes everything and ZEROES the counters. The doomed rows are READ (capturing
   * their blobKeys) before the metadata is deleted, so the keys are never lost.
   */
  async function purgeByApp(appId, { createdInDraftOnly = false } = {}) {
    // Snapshot the cutoff BEFORE the read and constrain BOTH the find and the
    // deleteMany to `createdAt <= before`: a row inserted mid-sweep is never deleted
    // without first being READ (so its blobKey is always captured) — no orphan blob.
    const before = new Date().toISOString()
    const filter = createdInDraftOnly
      ? { appId, createdInDraft: true, createdAt: { $lte: before } }
      : { appId, createdAt: { $lte: before } }
    // Bound the fetch by the per-app file cap (+1) rather than an arbitrary 1M — a
    // legitimate app can never exceed the cap, so this never truncates real data.
    const doomed = await withThrottleRetry(() =>
      collection.find(filter).limit(APP_FILE_COUNT_CAP + 1).toArray(),
    )
    const blobs = doomed.map((d) => ({ fileId: d._id, blobKey: d.blobKey }))
    const removed = doomed.length
    const bytes = doomed.reduce((sum, d) => sum + (d.size ?? 0), 0)
    await withThrottleRetry(() => collection.deleteMany(filter))
    if (createdInDraftOnly) {
      if (removed > 0) await releaseQuota(appId, removed, bytes)
    } else {
      // Full purge zeroes the counters. A row inserted mid-sweep (after `before`)
      // survives both the find and the deleteMany and is now uncounted — a bounded,
      // downward drift, self-healed by recompute (clear-data runs on a quiesced app;
      // the delete-app path drops the registry doc entirely right after).
      await registryRepo.setFileCounters(appId, { fileCount: 0, fileBytes: 0 })
    }
    return { removed, bytes, blobs }
  }

  /**
   * Admin RECOMPUTE: rebuild the counters from the `ready`-metadata aggregate (fixing
   * any bounded drift from a partial-failure compensation) AND sweep stale `pending`
   * rows (crashed uploads older than STALE_PENDING_MS) — metadata-only, NO object-store
   * enumeration. Returns the recomputed counters + the swept pending `{fileId, blobKey}`
   * list (so the route can best-effort delete any blob those crashed uploads did write).
   */
  async function recompute(appId) {
    // Bound the ready scan by the per-app file cap (+1) rather than an arbitrary 1M —
    // an app can never hold more `ready` files than the cap, so this never truncates.
    const ready = await withThrottleRetry(() =>
      collection.find({ appId, status: 'ready' }).limit(APP_FILE_COUNT_CAP + 1).toArray(),
    )
    const fileCount = ready.length
    const fileBytes = ready.reduce((sum, d) => sum + (d.size ?? 0), 0)
    await registryRepo.setFileCounters(appId, { fileCount, fileBytes })
    // Compute the stale cutoff ONCE and reuse the SAME value for the find and the
    // deleteMany, so a row that crosses the threshold between the two calls is never
    // deleted without its blobKey first captured in `sweptBlobs`.
    const staleFilter = {
      appId,
      status: 'pending',
      createdAt: { $lt: new Date(Date.now() - STALE_PENDING_MS).toISOString() },
    }
    const stale = await withThrottleRetry(() =>
      collection.find(staleFilter).limit(APP_FILE_COUNT_CAP + 1).toArray(),
    )
    const sweptBlobs = stale.map((d) => ({ fileId: d._id, blobKey: d.blobKey }))
    if (stale.length > 0) {
      await withThrottleRetry(() => collection.deleteMany(staleFilter))
    }
    return { fileCount, fileBytes, sweptPending: stale.length, sweptBlobs }
  }

  return { insert, markReady, list, get, del, purgeByApp, recompute }
}
