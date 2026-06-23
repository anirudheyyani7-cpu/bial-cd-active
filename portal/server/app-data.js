/**
 * Data Service router — the authenticated, per-app REST surface at
 * `/api/apps/:appId/records` (Decisions 1, 2, 9, 10). Every CRUD app the builder
 * generates calls THIS. Schemaless ("store and return whatever an app sends"),
 * but every write is tenant-scoped, sanitized, quota-bounded, and audited.
 *
 * Router middleware order is FIXED and load-bearing:
 *   requireAppKey → requireLoginIfRequired → perAppLimiter → handlers
 * The limiter MUST run AFTER requireAppKey so `req.appCtx` exists before its
 * keyGenerator reads `req.appCtx.appId` (mirrors feedback.js mounting its limiter
 * after requireAuth). It keys on the APP, not the IP, because all of BIAL shares
 * one corporate egress IP — IP keying would collapse every app into one bucket.
 * With express-rate-limit v8's MemoryStore an undefined key does NOT throw, it
 * silently collapses all apps into ONE shared bucket, so the ordering is a
 * correctness invariant guarded by a test, and the keyGenerator deliberately uses
 * NO optional chain (`req.appCtx.appId`) so a misorder fails loud, never silent.
 *
 * CORS is applied at the MOUNT (server.js), BEFORE the global SPA cors, so the
 * sandboxed opaque-origin iframe (Origin: null) preflight succeeds — auth here is
 * header-based (X-App-Key + Bearer) with NO cookies, so CORS grants no ambient
 * authority (the IP-restricted network is the real wall). The 256kb body cap is
 * likewise applied at the mount, before the global 100kb parser.
 *
 * Reuse: `safe(fn)` (a throw → clean 500, never a leak), `ID_RE`, and uniform
 * `{ error: { message } }` from the conversations/attachments routers.
 */
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import cors from 'cors'
import { createAppContext } from './app-context.js'
import { sanitizeData, sanitizeCollection, RecordQuotaError } from './data-records-repo.js'

// Per-app body cap: one record is small JSON; 256kb is generous and far under the
// global 100kb default it overrides for this path (applied at the server mount).
export const APP_DATA_BODY_LIMIT = '256kb'

// Server-minted record ids are crypto.randomUUID(); bound the shape defensively.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Scoped CORS for the data routes. Reflects the request Origin (including 'null'
 * from the sandboxed opaque-origin iframe) and allows the auth headers. NO
 * credentials → no cookies → no ambient authority. Mounted BEFORE the global SPA
 * cors so the null-origin preflight is answered with the right headers.
 */
export function makeDataServiceCors() {
  return cors({
    origin: true, // reflect Origin (incl. 'null'); header-auth only, no cookies
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Key'],
    maxAge: 600,
  })
}

/**
 * Per-app rate limiter, keyed by `req.appCtx.appId` (NOT IP). Suggested 120/min
 * per app. In-memory store → per-instance ceiling (a shared Redis store is the
 * multi-replica follow-up). NO optional chain on req.appCtx — always mounted
 * after requireAppKey; a misorder must fail loud, not collapse into one bucket.
 */
export function makeAppDataLimiter(options = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.appCtx.appId,
    handler: (_req, res) =>
      res.status(429).json({ error: { message: 'Too many requests for this app. Please slow down.' } }),
    ...options,
  })
}

/** Wrap an async handler so an unexpected throw becomes a clean 500, never a leak. */
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('app-data route error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: { message: 'Request failed. Please retry.' } })
  }
}

/** Client-facing record shape — never leaks the internal `appId`/`bytes`. */
function project(rec) {
  return {
    id: rec._id,
    collection: rec.collection,
    data: rec.data,
    createdBy: rec.createdBy ?? null,
    createdInDraft: Boolean(rec.createdInDraft),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  }
}

/** Map a RecordQuotaError to a 413; rethrow anything else for `safe` to 500. */
function handleWriteError(err, res) {
  if (err instanceof RecordQuotaError) {
    return res.status(413).json({ error: { message: err.message, code: err.code } })
  }
  throw err
}

export function createAppDataRouter({ dataRecordsRepo, auditRepo, registryRepo }, { limiter } = {}) {
  if (!dataRecordsRepo) throw new Error('createAppDataRouter: dataRecordsRepo is required')
  if (!auditRepo) throw new Error('createAppDataRouter: auditRepo is required')
  if (!registryRepo) throw new Error('createAppDataRouter: registryRepo is required')

  const { requireAppKey, requireLoginIfRequired } = createAppContext({ registryRepo })
  const perAppLimiter = limiter ?? makeAppDataLimiter()
  // mergeParams so `:appId` from the mount path (`/api/apps/:appId/records`) is
  // visible to requireAppKey's URL-vs-key cross-check and the handlers.
  const router = Router({ mergeParams: true })

  // FIXED order: resolve+verify the app, enforce live login, THEN rate-limit (so
  // the limiter can key on req.appCtx.appId), then the handlers.
  router.use(requireAppKey)
  router.use(requireLoginIfRequired)
  router.use(perAppLimiter)

  // The actor is the verified portal user (login apps) or null (open apps); the
  // draft tag marks rows written before approval so clear-data can target them.
  const actorOf = (req) => req.user?.sub ?? null
  const draftTag = (req) => req.appCtx.status !== 'approved'

  // Create a record.
  router.post(
    '/',
    safe(async (req, res) => {
      const { collection, data } = req.body || {}
      const coll = sanitizeCollection(collection)
      if (!coll.ok) return res.status(400).json({ error: { message: coll.error } })
      const clean = sanitizeData(data)
      if (!clean.ok) return res.status(400).json({ error: { message: clean.error } })
      try {
        const rec = await dataRecordsRepo.insert({
          appId: req.appCtx.appId,
          collection: coll.value,
          data: clean.value,
          createdBy: actorOf(req),
          createdInDraft: draftTag(req),
        })
        await auditRepo.record({
          appId: req.appCtx.appId,
          username: actorOf(req),
          action: 'create',
          collection: rec.collection,
          recordId: rec._id,
        })
        res.status(201).json(project(rec))
      } catch (err) {
        handleWriteError(err, res)
      }
    }),
  )

  // List records (newest-first, capped). Reads are NOT audited (Decision 9).
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
      const records = await dataRecordsRepo.list(req.appCtx.appId, { collection, limit })
      res.json({ records: records.map(project) })
    }),
  )

  // Read one record in the caller's tenant.
  router.get(
    '/:id',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid record id.' } })
      const rec = await dataRecordsRepo.get(req.appCtx.appId, id)
      if (!rec) return res.status(404).json({ error: { message: 'Record not found.' } })
      res.json({ record: project(rec) })
    }),
  )

  // PATCH-merge a record the caller owns.
  router.patch(
    '/:id',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid record id.' } })
      const clean = sanitizeData((req.body || {}).data)
      if (!clean.ok) return res.status(400).json({ error: { message: clean.error } })
      try {
        const rec = await dataRecordsRepo.update(req.appCtx.appId, id, clean.value)
        if (!rec) return res.status(404).json({ error: { message: 'Record not found.' } })
        await auditRepo.record({
          appId: req.appCtx.appId,
          username: actorOf(req),
          action: 'update',
          collection: rec.collection,
          recordId: rec._id,
        })
        res.json({ record: project(rec) })
      } catch (err) {
        handleWriteError(err, res)
      }
    }),
  )

  // Hard-delete a record the caller owns; the audit event is the accountability
  // record (Decision 9: "who did what, especially deletes").
  router.delete(
    '/:id',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid record id.' } })
      const result = await dataRecordsRepo.del(req.appCtx.appId, id)
      if (!result.deleted) return res.status(404).json({ error: { message: 'Record not found.' } })
      await auditRepo.record({
        appId: req.appCtx.appId,
        username: actorOf(req),
        action: 'delete',
        recordId: id,
      })
      res.json({ ok: true })
    }),
  )

  return router
}
