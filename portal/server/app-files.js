/**
 * File Service router — the authenticated, per-app FILE surface at
 * `/api/apps/:appId/files` (Decisions 1, 2, 3, 6, 7, 8). The file-side twin of the
 * records router: same `requireAppKey → requireLoginIfRequired → perAppLimiter`
 * chain, same composite `{_id, appId}` tenant isolation resolved from the VERIFIED
 * app context (never the body), same append-only audit, same scoped `/api/apps/*`
 * CORS. Only the bytes differ — they ride the ObjectStore, proxied on upload (so
 * type/size/quota are enforced at the gateway) and offloaded on download via a
 * short-lived SAS the backend mints (the blob host stays OUT of the sandbox CSP).
 *
 * Two-store integrity is ORDERED (Decision 6):
 *   UPLOAD: reserve+insert `pending` → put blob → markReady. A put failure deletes
 *           the pending row + releases the reserve (no unreachable blob).
 *   DELETE: delete blob (idempotent) → del metadata → release quota.
 *
 * Two read paths, chosen by intent (Decision 3):
 *   GET /:id/url     → a short-lived read SAS for `<a download>` (bytes bypass Node).
 *   GET /:id/content → a same-origin HARDENED proxy of the bytes for re-parse / inline
 *                      render (nosniff + octet-stream/attachment for non-image +
 *                      sniffed type for image + a per-response `default-src 'none';
 *                      sandbox` CSP — the real, content-type-independent XSS mitigation).
 *
 * The body parser carve-out + mount order live in server.js (the `/files` 25 MB
 * parser must precede the broad `/api/apps` 256 KB parser, and this router must
 * precede the `/api/apps` deploy catch-all). Reuses `safe`/`ID_RE`/uniform errors.
 */
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createAppContext } from './app-context.js'
import { posIntOr } from './util-validate.js'
import { isNotFound } from './object-store.js'
import {
  sanitizeFilename,
  sanitizeCollection,
  assertContentType,
  sniffMagic,
  sniffImageType,
  FileQuotaError,
} from './app-files-repo.js'

// The raised express.json body-parser limit for the upload route (base64 inflates
// ~37%, so this exceeds APP_FILE_MAX_BYTES). Mounted in server.js BEFORE the broad
// /api/apps 256 KB parser — body-parser consumes once at first match.
export const APP_FILE_MAX_JSON = process.env.APP_FILE_MAX_JSON || '25mb'
// Max DECODED bytes per file (checked after base64 decode). The binding upload cap.
const APP_FILE_MAX_BYTES = posIntOr(process.env.APP_FILE_MAX_BYTES, 18 * 1024 * 1024)
// Download SAS / presign lifetime (seconds). Short by design.
const FILE_SAS_TTL_SECONDS = posIntOr(process.env.FILE_SAS_TTL_SECONDS, 120)

// Server-minted file ids are crypto.randomUUID(); bound the shape defensively.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Per-app file rate limiter, keyed by `req.appCtx.appId` (NOT IP — all of BIAL
 * shares one egress IP). Mounted AFTER requireAppKey so req.appCtx exists; NO
 * optional chain, so a misorder fails loud rather than collapsing every app into one
 * bucket. Covers uploads + downloads + deletes on the file surface.
 */
export function makeAppFileLimiter(options = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.appCtx.appId,
    handler: (_req, res) =>
      res.status(429).json({ error: { message: 'Too many file requests for this app. Please slow down.' } }),
    ...options,
  })
}

/** Wrap an async handler so an unexpected throw becomes a clean 500, never a leak. */
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('app-files route error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: { message: 'Request failed. Please retry.' } })
  }
}

/** Client-facing file shape — never leaks the internal `appId`/`blobKey`/`status`. */
function project(f) {
  return {
    fileId: f._id,
    collection: f.collection,
    filename: f.filename,
    contentType: f.contentType,
    size: f.size,
    createdBy: f.createdBy ?? null,
    createdInDraft: Boolean(f.createdInDraft),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }
}

/** A safe Content-Disposition filename for a stored file (re-validated; fallback). */
function dispositionName(meta, id) {
  const fn = sanitizeFilename(meta?.filename)
  return fn.ok ? fn.value : `file-${id}`
}

/** Map a FileQuotaError to a 413; rethrow anything else for `safe` to 500. */
function handleWriteError(err, res) {
  if (err instanceof FileQuotaError) {
    return res.status(413).json({ error: { message: err.message, code: err.code } })
  }
  throw err
}

export function createAppFilesRouter({ appFilesRepo, auditRepo, registryRepo, objectStore }, { limiter } = {}) {
  if (!appFilesRepo) throw new Error('createAppFilesRouter: appFilesRepo is required')
  if (!auditRepo) throw new Error('createAppFilesRouter: auditRepo is required')
  if (!registryRepo) throw new Error('createAppFilesRouter: registryRepo is required')
  if (!objectStore) throw new Error('createAppFilesRouter: objectStore is required')

  const { requireAppKey, requireLoginIfRequired } = createAppContext({ registryRepo })
  const perAppLimiter = limiter ?? makeAppFileLimiter()
  const router = Router({ mergeParams: true })

  // FIXED order: verify the app, enforce live login, THEN rate-limit (so the limiter
  // keys on req.appCtx.appId), then the handlers.
  router.use(requireAppKey)
  router.use(requireLoginIfRequired)
  router.use(perAppLimiter)

  const actorOf = (req) => req.user?.sub ?? null
  const draftTag = (req) => req.appCtx.status !== 'approved'

  // Best-effort audit (runs after the mutation has committed; a failed audit write
  // must not turn a successful op into a 500). Mirrors app-data.js.
  const audit = async (event) => {
    try {
      await auditRepo.record(event)
    } catch (err) {
      console.error('app-files audit write failed (non-fatal):', err.message)
    }
  }

  // Upload one file (proxy; pending→ready). Bytes stream THROUGH the backend so the
  // allowlist + magic + size + quota are all enforced at the gateway.
  router.post(
    '/',
    safe(async (req, res) => {
      const { collection, filename, contentType, base64 } = req.body || {}
      const coll = sanitizeCollection(collection)
      if (!coll.ok) return res.status(400).json({ error: { message: coll.error } })
      const fn = sanitizeFilename(filename)
      if (!fn.ok) return res.status(400).json({ error: { message: fn.error } })
      const ct = assertContentType(contentType)
      if (!ct.ok) return res.status(400).json({ error: { message: ct.error } })
      if (typeof base64 !== 'string' || base64.length === 0) {
        return res.status(400).json({ error: { message: 'base64 file bytes are required.' } })
      }
      const buffer = Buffer.from(base64, 'base64')
      if (buffer.length === 0) return res.status(400).json({ error: { message: 'Decoded file is empty.' } })
      if (buffer.length > APP_FILE_MAX_BYTES) {
        return res.status(413).json({ error: { message: `File is too large (max ${Math.round(APP_FILE_MAX_BYTES / (1024 * 1024))} MB).` } })
      }
      const magic = sniffMagic(ct.value, buffer)
      if (!magic.ok) return res.status(400).json({ error: { message: magic.error } })

      // Reserve quota + insert the metadata in the `pending` state.
      let meta
      try {
        meta = await appFilesRepo.insert({
          appId: req.appCtx.appId,
          collection: coll.value,
          filename: fn.value,
          contentType: ct.value,
          size: buffer.length, // trust the DECODED bytes, never a client-claimed size
          createdBy: actorOf(req),
          createdInDraft: draftTag(req),
        })
      } catch (err) {
        return handleWriteError(err, res)
      }
      // Write the blob, THEN mark ready. A put failure compensates (delete the pending
      // row + release the reserve) so no unreachable blob and no stuck reserve remain.
      try {
        await objectStore.put(meta.blobKey, buffer, ct.value)
      } catch (err) {
        try {
          await appFilesRepo.del(req.appCtx.appId, meta._id)
        } catch (e) {
          console.error('file upload compensation failed (stale pending swept by recompute):', e.message)
        }
        throw err
      }
      // markReady can also fail (a Cosmos throttle/timeout AFTER the blob is written):
      // compensate it the same way as the put failure — delete the pending row + the
      // just-written blob is left for recompute/blob-GC — so a failed flip never leaves
      // a stuck `pending` reserve, then re-throw for `safe` to 500.
      try {
        await appFilesRepo.markReady(req.appCtx.appId, meta._id)
      } catch (err) {
        try {
          await appFilesRepo.del(req.appCtx.appId, meta._id)
        } catch (e) {
          console.error('file markReady compensation failed (stale pending swept by recompute):', e.message)
        }
        throw err
      }
      await audit({
        appId: req.appCtx.appId,
        username: actorOf(req),
        action: 'file:create',
        collection: meta.collection,
        recordId: meta._id,
      })
      res.status(201).json(project(meta))
    }),
  )

  // List ready files (newest-first, capped). Reads are NOT audited.
  router.get(
    '/',
    safe(async (req, res) => {
      let collection
      if (typeof req.query.collection === 'string') {
        const coll = sanitizeCollection(req.query.collection)
        if (!coll.ok) return res.status(400).json({ error: { message: coll.error } })
        collection = coll.value
      }
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined
      const files = await appFilesRepo.list(req.appCtx.appId, { collection, limit })
      res.json({ files: files.map(project) })
    }),
  )

  // Mint a short-lived download SAS for `<a download>`. The metadata read (composite
  // {_id, appId, status:ready}) 404s a non-owned/non-ready file WITHOUT ever calling
  // the SDK signer — so model code can never have an arbitrary blob signed.
  router.get(
    '/:id/url',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid file id.' } })
      const meta = await appFilesRepo.get(req.appCtx.appId, id)
      if (!meta) return res.status(404).json({ error: { message: 'File not found.' } })
      let url
      try {
        url = await objectStore.getDownloadUrl(meta.blobKey, {
          expiresInSeconds: FILE_SAS_TTL_SECONDS,
          filename: dispositionName(meta, id),
          contentType: meta.contentType,
        })
      } catch (err) {
        // The provider can't sign (e.g. a misconfigured S3 local-dev) → 501; the
        // client falls back to the /content proxy.
        console.error('getDownloadUrl failed (provider cannot sign):', err.message)
        return res.status(501).json({ error: { message: 'Signed downloads are not available for this deployment. Use the content endpoint.' } })
      }
      await audit({ appId: req.appCtx.appId, username: actorOf(req), action: 'file:url', recordId: id })
      res.json({ url, expiresAt: new Date(Date.now() + FILE_SAS_TTL_SECONDS * 1000).toISOString() })
    }),
  )

  // Same-origin HARDENED byte proxy for re-parse / inline render. ALWAYS nosniff +
  // a per-response `default-src 'none'; sandbox` CSP (the real mitigation). Image
  // types are served as their SNIFFED type inline; everything else as octet-stream +
  // attachment, so a mistyped upload can't become a portal-origin stored-XSS surface.
  router.get(
    '/:id/content',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid file id.' } })
      const meta = await appFilesRepo.get(req.appCtx.appId, id)
      if (!meta) return res.status(404).json({ error: { message: 'File not found.' } })
      let buffer
      try {
        buffer = await objectStore.get(meta.blobKey)
      } catch (err) {
        if (isNotFound(err)) return res.status(404).json({ error: { message: 'File not found.' } })
        throw err
      }
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'private')
      // The REAL, content-type-independent mitigation: even a malicious PDF/HTML can't
      // execute script if navigated to top-level. BOTH directives.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
      const imageType = sniffImageType(buffer)
      const safeName = dispositionName(meta, id)
      if (imageType) {
        res.setHeader('Content-Type', imageType) // sniffed, not the stored type
        res.setHeader('Content-Disposition', `inline; filename="${safeName}"`)
      } else {
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
      }
      res.send(buffer)
    }),
  )

  // File metadata (composite point read).
  router.get(
    '/:id',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid file id.' } })
      const meta = await appFilesRepo.get(req.appCtx.appId, id)
      if (!meta) return res.status(404).json({ error: { message: 'File not found.' } })
      res.json({ file: project(meta) })
    }),
  )

  // Hard-delete: blob (idempotent) → metadata → quota release. A genuine (non-absent)
  // blob-store error keeps the row (retryable) and releases nothing.
  router.delete(
    '/:id',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid file id.' } })
      const meta = await appFilesRepo.get(req.appCtx.appId, id)
      if (!meta) return res.status(404).json({ error: { message: 'File not found.' } })
      try {
        await objectStore.delete(meta.blobKey)
      } catch (err) {
        if (!isNotFound(err)) throw err // genuine store error → 500, row kept (retryable), quota not released
        // absent blob (NoSuchKey/NotFound) → idempotent success; continue.
      }
      await appFilesRepo.del(req.appCtx.appId, id, { existing: meta }) // reuse the doc read above; skip the internal re-get
      await audit({ appId: req.appCtx.appId, username: actorOf(req), action: 'file:delete', recordId: id })
      res.json({ ok: true })
    }),
  )

  return router
}
