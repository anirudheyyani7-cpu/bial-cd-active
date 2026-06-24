/**
 * File-parse router — the authenticated, per-app PARSE surface at
 * `/api/apps/:appId/parse` (R1–R5, R8). The app-runtime twin of the chat
 * extraction path: a generated app sends a file (or names a stored one) and gets
 * back STRUCTURED data — spreadsheet rows or document text — to drive dashboards.
 *
 * ONE polymorphic endpoint (mirrors how uploadFile already accepts both shapes):
 *   - { fileId }                          → re-parse a STORED file (F3: list→pick→view).
 *                                           Bytes are read from the object store after a
 *                                           composite {_id, appId, status:ready} metadata
 *                                           read, so a foreign/guessed id 404s.
 *   - { filename, contentType, base64 }   → parse FRESH bytes, nothing persisted
 *                                           (F1: view-only dashboard, no login, no storage).
 *   - optional { sheet }                  → choose a worksheet (R4); default = first.
 *
 * Same auth chain as the records/files routers (requireAppKey →
 * requireLoginIfRequired → perAppLimiter) and the SAME tenant isolation resolved
 * from the verified app context, never the body. The CPU-bound parse runs in a
 * worker under a hard time budget (file-parse-runner.js) so an untrusted file can
 * neither block the event loop nor outrun the budget. Reads are not audited
 * (mirrors list/content); nothing is mutated on this surface.
 *
 * The body-parser carve-out + mount order live in server.js: the `/parse` parser
 * (sized like `/files` for inline base64) must precede the broad `/api/apps`
 * 256 KB parser, and this router must precede the `/api/apps` deploy catch-all.
 */
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createAppContext } from './app-context.js'
import { posIntOr } from './util-validate.js'
import { isNotFound } from './object-store.js'
import { sanitizeFilename } from './app-files-repo.js'
import { APP_FILE_MAX_JSON } from './app-files.js'
import { parseKindFor } from './file-parse.js'
import { parseInWorker } from './file-parse-runner.js'

// Inline parse reuses the file upload's body-parser cap (base64 of an ~18 MB file
// is ~24 MB). Re-exported so server.js mounts the /parse parser before the broad one.
export { APP_FILE_MAX_JSON }
// Max DECODED bytes for an inline parse — same binding cap as a file upload.
const APP_FILE_MAX_BYTES = posIntOr(process.env.APP_FILE_MAX_BYTES, 18 * 1024 * 1024)
// Server-minted file ids are crypto.randomUUID(); bound the shape defensively.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Per-app parse rate limiter, keyed by appId (NOT IP — all of BIAL shares one
 * egress IP). Lower than the file limiter because a parse is heavier than a
 * metadata read. Mounted AFTER requireAppKey so req.appCtx exists.
 */
export function makeAppParseLimiter(options = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.appCtx.appId,
    handler: (_req, res) =>
      res.status(429).json({ error: { message: 'Too many parse requests for this app. Please slow down.' } }),
    ...options,
  })
}

/** Wrap an async handler so an unexpected throw becomes a clean 500, never a leak. */
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('app-parse route error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: { message: 'Request failed. Please retry.' } })
  }
}

const fail = (res, status, message, code) =>
  res.status(status).json({ error: code ? { message, code } : { message } })

/**
 * @param {object} deps
 * @param {object} deps.appFilesRepo   - per-app file metadata store (stored-file lookup)
 * @param {object} deps.registryRepo   - app registry (app-context verification)
 * @param {object} deps.objectStore    - blob store (stored-file bytes)
 * @param {Function} [deps.runParse]   - parse fn (default: worker runner); injectable for tests
 * @param {object} [opts]
 * @param {object} [opts.limiter]      - override the per-app limiter (tests)
 */
export function createAppParseRouter({ appFilesRepo, registryRepo, objectStore, runParse = parseInWorker }, { limiter } = {}) {
  if (!appFilesRepo) throw new Error('createAppParseRouter: appFilesRepo is required')
  if (!registryRepo) throw new Error('createAppParseRouter: registryRepo is required')
  if (!objectStore) throw new Error('createAppParseRouter: objectStore is required')

  const { requireAppKey, requireLoginIfRequired } = createAppContext({ registryRepo })
  const perAppLimiter = limiter ?? makeAppParseLimiter()
  const router = Router({ mergeParams: true })

  // FIXED order: verify the app, enforce live login, THEN rate-limit (keyed on appId).
  router.use(requireAppKey)
  router.use(requireLoginIfRequired)
  router.use(perAppLimiter)

  router.post(
    '/',
    safe(async (req, res) => {
      const { fileId, filename, contentType, base64, sheet } = req.body || {}
      if (sheet != null && typeof sheet !== 'string') {
        return fail(res, 400, 'sheet must be a worksheet name (string).')
      }

      let buffer
      let ct
      let name

      if (fileId != null && fileId !== '') {
        // Stored-file path (F3): resolve metadata composite-scoped, THEN fetch bytes.
        if (!ID_RE.test(fileId)) return fail(res, 400, 'Invalid file id.')
        const meta = await appFilesRepo.get(req.appCtx.appId, fileId)
        if (!meta) return fail(res, 404, 'File not found.')
        ct = meta.contentType
        name = meta.filename
        if (!parseKindFor(ct, name)) {
          return fail(res, 415, 'This file type cannot be parsed into data. Supported: Excel (.xlsx/.xls), CSV, Word (.docx).', 'UNSUPPORTED_TYPE')
        }
        try {
          buffer = await objectStore.get(meta.blobKey)
        } catch (err) {
          if (isNotFound(err)) return fail(res, 404, 'File not found.')
          throw err
        }
      } else {
        // Inline-bytes path (F1): fresh file, nothing persisted.
        if (typeof contentType !== 'string' || contentType.length === 0) {
          return fail(res, 400, 'contentType is required.')
        }
        name = ''
        if (filename != null) {
          const fn = sanitizeFilename(filename)
          if (!fn.ok) return fail(res, 400, fn.error)
          name = fn.value
        }
        if (typeof base64 !== 'string' || base64.length === 0) {
          return fail(res, 400, 'base64 file bytes (or a fileId) are required.')
        }
        buffer = Buffer.from(base64, 'base64')
        if (buffer.length === 0) return fail(res, 400, 'Decoded file is empty.')
        if (buffer.length > APP_FILE_MAX_BYTES) {
          return fail(res, 413, `File is too large (max ${Math.round(APP_FILE_MAX_BYTES / (1024 * 1024))} MB).`)
        }
        ct = contentType
        if (!parseKindFor(ct, name)) {
          return fail(res, 415, 'This file type cannot be parsed into data. Supported: Excel (.xlsx/.xls), CSV, Word (.docx).', 'UNSUPPORTED_TYPE')
        }
      }

      try {
        const result = await runParse({ buffer, contentType: ct, filename: name, sheet: typeof sheet === 'string' ? sheet : undefined })
        return res.json(result)
      } catch (err) {
        // The worker normalises every failure to a status+code-bearing error.
        return fail(res, err.status || 400, err.message || 'Could not parse the file.', err.code)
      }
    }),
  )

  return router
}
