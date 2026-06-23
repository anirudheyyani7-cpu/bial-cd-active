/**
 * Admin App Registry routes — mounted at /api/admin/apps behind requireAuth +
 * requireAdmin (applied at the mount in server.js), so every handler assumes a
 * verified admin caller.
 *
 * U8 ships the approval lifecycle: approve (copy code.source → approvedSnapshot
 * with a server-side pre-compile; reject the approval if it won't compile; set
 * approvedBy/at) and reject (+ note). Both audit the admin action (Decision 9 —
 * "who did what, especially deletes" includes admin destructive/governance
 * actions). U10 extends this router with list / loginRequired-toggle / disable /
 * two-step clear-data / delete / audit-view.
 *
 * Approve compiles BEFORE any state change, so a snapshot that won't compile
 * leaves the app `pending` and untouched. The transition machine is enforced by
 * the registry repo, so approve/reject on a non-pending app is a clean 409.
 */
import express from 'express'
import { randomBytes } from 'node:crypto'
import { compileJsx } from '../jsx-compile.js'

const MAX_NOTE = 1000
// Two-step clear-data confirm tokens: minted by the data-summary preflight,
// single-use, short-lived (in-memory, per-instance — a destructive op gate, not
// a security boundary; the route is already admin-gated).
const CLEAR_TOKEN_TTL_MS = 2 * 60 * 1000

/** Admin-facing projection — never leaks the code blobs or the app key. */
function projectApp(a) {
  return {
    appId: a._id,
    name: a.name || '',
    ownerUsername: a.ownerUsername || null,
    status: a.status,
    loginRequired: Boolean(a.loginRequired),
    dataCount: a.dataCount || 0,
    dataBytes: a.dataBytes || 0,
    fileCount: a.fileCount || 0,
    fileBytes: a.fileBytes || 0,
    hasApprovedSnapshot: typeof a.code?.approvedSnapshot?.compiled === 'string',
    approvedBy: a.approvedBy || null,
    approvedAt: a.approvedAt || null,
    rejectionNote: a.rejectionNote || null,
    dataSchema: a.dataSchema || null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('admin apps route error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: { message: 'Request failed. Please retry.' } })
  }
}

export function createAdminAppsRouter({ registryRepo, auditRepo, dataRecordsRepo, appFilesRepo, objectStore } = {}) {
  if (!registryRepo) throw new Error('createAdminAppsRouter: registryRepo is required')
  if (!auditRepo) throw new Error('createAdminAppsRouter: auditRepo is required')
  if (!dataRecordsRepo) throw new Error('createAdminAppsRouter: dataRecordsRepo is required')
  if (!appFilesRepo) throw new Error('createAdminAppsRouter: appFilesRepo is required')
  if (!objectStore) throw new Error('createAdminAppsRouter: objectStore is required')
  const router = express.Router()

  // Single-use clear-data confirm tokens (token → { appId, exp }).
  const clearTokens = new Map()
  const pruneClearTokens = () => {
    const now = Date.now()
    for (const [t, v] of clearTokens) if (v.exp < now) clearTokens.delete(t)
  }

  /** An object-store error that means "blob already absent" (idempotent delete). */
  const isNotFound = (err) =>
    err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404

  /**
   * Best-effort delete of a `[{ fileId, blobKey }]` list from the object store. The
   * metadata is already gone by the time we get here (purgeByApp/recompute delete it
   * and RETURN the keys), so a genuine store error is logged but never aborts: the
   * residual is a bounded storage-cost orphan the deferred blob-GC mops up — far less
   * harmful than failing the whole admin op after the metadata is destroyed.
   */
  const deleteBlobs = async (blobs) => {
    for (const b of blobs || []) {
      if (!b?.blobKey) continue
      try {
        await objectStore.delete(b.blobKey)
      } catch (err) {
        if (!isNotFound(err)) console.error('admin file blob delete failed (non-fatal):', b.blobKey, err.message)
      }
    }
  }

  // List apps (optionally filtered by status), newest-first, explicitly projected.
  router.get(
    '/',
    safe(async (req, res) => {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined
      const apps = await registryRepo.listApps({ status })
      res.json({ apps: apps.map(projectApp) })
    }),
  )

  // Approve a pending app: pre-compile the submitted source, snapshot it, and go
  // approved. A compile failure → 422, status unchanged.
  router.post(
    '/:appId/approve',
    safe(async (req, res) => {
      const { appId } = req.params
      const app = await registryRepo.getApp(appId)
      if (!app) return res.status(404).json({ error: { message: 'App not found.' } })
      if (app.status !== 'pending') {
        return res.status(409).json({ error: { message: 'Only a pending app can be approved.' } })
      }
      const source = app.code?.source
      if (!source || typeof source.src !== 'string') {
        return res.status(400).json({ error: { message: 'No submitted code to approve.' } })
      }

      let compiled
      try {
        compiled = compileJsx(source.src) // BEFORE any state change
      } catch (err) {
        return res.status(422).json({ error: { message: `The submitted code failed to compile: ${err.message}` } })
      }

      const now = new Date().toISOString()
      await registryRepo.setSnapshots(appId, {
        approvedSnapshot: { compiled, src: source.src, entry: source.entry || 'PreviewApp', at: now, by: req.user.sub },
      })
      const moved = await registryRepo.setStatus(appId, 'approved', { approvedBy: req.user.sub, approvedAt: now })
      if (!moved.ok) return res.status(409).json({ error: { message: 'Could not approve in the current state.' } })
      await auditRepo.record({ appId, username: req.user.sub, action: 'approve' })
      res.json({ appId, status: 'approved' })
    }),
  )

  // Reject a pending app with an optional note (shown back to the builder).
  router.post(
    '/:appId/reject',
    safe(async (req, res) => {
      const { appId } = req.params
      const app = await registryRepo.getApp(appId)
      if (!app) return res.status(404).json({ error: { message: 'App not found.' } })
      if (app.status !== 'pending') {
        return res.status(409).json({ error: { message: 'Only a pending app can be rejected.' } })
      }
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, MAX_NOTE) : ''
      const moved = await registryRepo.setStatus(appId, 'rejected', { rejectionNote: note })
      if (!moved.ok) return res.status(409).json({ error: { message: 'Could not reject in the current state.' } })
      await auditRepo.record({ appId, username: req.user.sub, action: 'reject' })
      res.json({ appId, status: 'rejected' })
    }),
  )

  // Patch name / loginRequired. A loginRequired FLIP is itself audited (Decision 9
  // — "login cannot be prompted away," and turning it off on a sensitive app must
  // leave a footprint). Identity (appKey) + status are never touched here.
  router.patch(
    '/:appId',
    safe(async (req, res) => {
      const { appId } = req.params
      const app = await registryRepo.getApp(appId)
      if (!app) return res.status(404).json({ error: { message: 'App not found.' } })
      const patch = {}
      if (req.body?.name !== undefined) {
        if (typeof req.body.name !== 'string') return res.status(400).json({ error: { message: 'name must be a string.' } })
        patch.name = req.body.name.slice(0, 120)
      }
      let loginFlipped = false
      if (req.body?.loginRequired !== undefined) {
        if (typeof req.body.loginRequired !== 'boolean') {
          return res.status(400).json({ error: { message: 'loginRequired must be a boolean.' } })
        }
        patch.loginRequired = req.body.loginRequired
        loginFlipped = Boolean(app.loginRequired) !== req.body.loginRequired
      }
      await registryRepo.patchApp(appId, patch)
      if (loginFlipped) {
        await auditRepo.record({ appId, username: req.user.sub, action: 'config:loginRequired', count: patch.loginRequired ? 1 : 0 })
      }
      res.json(projectApp({ ...app, ...patch }))
    }),
  )

  // Disable (kill-switch; approved → disabled) and re-enable (disabled → approved).
  router.post(
    '/:appId/disable',
    safe(async (req, res) => {
      const { appId } = req.params
      const app = await registryRepo.getApp(appId)
      if (!app) return res.status(404).json({ error: { message: 'App not found.' } })
      const moved = await registryRepo.setStatus(appId, 'disabled')
      if (!moved.ok) return res.status(409).json({ error: { message: 'Only an approved app can be disabled.' } })
      await auditRepo.record({ appId, username: req.user.sub, action: 'disable' })
      res.json({ appId, status: 'disabled' })
    }),
  )

  router.post(
    '/:appId/enable',
    safe(async (req, res) => {
      const { appId } = req.params
      const app = await registryRepo.getApp(appId)
      if (!app) return res.status(404).json({ error: { message: 'App not found.' } })
      // Re-enable is ONLY disabled→approved. The transition machine also permits
      // pending→approved (that is the approve route's path, which compiles + snapshots
      // first), so without this guard /enable could promote an un-compiled pending app
      // straight to approved, bypassing the approval gate. Refuse anything but disabled.
      if (app.status !== 'disabled') return res.status(409).json({ error: { message: 'Only a disabled app can be re-enabled.' } })
      const moved = await registryRepo.setStatus(appId, 'approved')
      if (!moved.ok) return res.status(409).json({ error: { message: 'Only a disabled app can be re-enabled.' } })
      await auditRepo.record({ appId, username: req.user.sub, action: 'enable' })
      res.json({ appId, status: 'approved' })
    }),
  )

  // Clear-data step 1: a preflight that returns the affected count/bytes + a
  // single-use confirm token (no destruction yet).
  router.get(
    '/:appId/data-summary',
    safe(async (req, res) => {
      const { appId } = req.params
      const app = await registryRepo.getApp(appId)
      if (!app) return res.status(404).json({ error: { message: 'App not found.' } })
      pruneClearTokens()
      const confirmToken = randomBytes(16).toString('base64url')
      clearTokens.set(confirmToken, { appId, exp: Date.now() + CLEAR_TOKEN_TTL_MS })
      res.json({
        appId,
        dataCount: app.dataCount || 0,
        dataBytes: app.dataBytes || 0,
        fileCount: app.fileCount || 0,
        fileBytes: app.fileBytes || 0,
        confirmToken,
      })
    }),
  )

  // Clear-data step 2: the destructive op, gated on the single-use token. Audited
  // with the affected count. `createdInDraftOnly` purges only build-time test rows.
  router.post(
    '/:appId/clear-data',
    safe(async (req, res) => {
      const { appId } = req.params
      const { confirmToken, createdInDraftOnly } = req.body || {}
      const entry = confirmToken && clearTokens.get(confirmToken)
      if (!entry || entry.appId !== appId || entry.exp < Date.now()) {
        return res.status(400).json({ error: { message: 'Invalid or expired confirmation. Please retry.' } })
      }
      clearTokens.delete(confirmToken) // single-use
      const draftOnly = Boolean(createdInDraftOnly)
      const { removed } = await dataRecordsRepo.purgeByApp(appId, { createdInDraftOnly: draftOnly })
      await auditRepo.record({ appId, username: req.user.sub, action: 'clear-data', count: removed })
      // Files share the same two-step gate. purgeByApp deletes the metadata + reconciles
      // the counters and RETURNS the blobKeys; we then delete the blobs (best-effort).
      const filePurge = await appFilesRepo.purgeByApp(appId, { createdInDraftOnly: draftOnly })
      await deleteBlobs(filePurge.blobs)
      if (filePurge.removed > 0) {
        await auditRepo.record({ appId, username: req.user.sub, action: 'file:clear', count: filePurge.removed })
      }
      res.json({ appId, removed, filesRemoved: filePurge.removed })
    }),
  )

  // Recompute file counters from the `ready`-metadata aggregate (fixing bounded drift
  // from a partial-failure compensation) and sweep stale `pending` rows (crashed
  // uploads). A SYSTEM governance action (no human-authored mutation) → audited file:gc.
  router.post(
    '/:appId/recompute-files',
    safe(async (req, res) => {
      const { appId } = req.params
      const app = await registryRepo.getApp(appId)
      if (!app) return res.status(404).json({ error: { message: 'App not found.' } })
      const result = await appFilesRepo.recompute(appId)
      await deleteBlobs(result.sweptBlobs) // best-effort: drop any blob a crashed upload did write
      await auditRepo.record({ appId, username: req.user.sub, action: 'file:gc', count: result.sweptPending })
      res.json({ appId, fileCount: result.fileCount, fileBytes: result.fileBytes, sweptPending: result.sweptPending })
    }),
  )

  // Hard-delete an app: write a FINAL app:delete audit event, purge all its data AND
  // files (blobs too — the blobKeys live in the file metadata, which the registry doc
  // delete does not cascade), THEN delete the registry doc (deletion governance,
  // Decision 7). File blobs are purged BEFORE the registry doc is gone.
  router.delete(
    '/:appId',
    safe(async (req, res) => {
      const { appId } = req.params
      const app = await registryRepo.getApp(appId)
      if (!app) return res.status(404).json({ error: { message: 'App not found.' } })
      await auditRepo.record({ appId, username: req.user.sub, action: 'app:delete', count: app.dataCount || 0 })
      await dataRecordsRepo.purgeByApp(appId, {})
      const filePurge = await appFilesRepo.purgeByApp(appId, {})
      await deleteBlobs(filePurge.blobs)
      await registryRepo.deleteApp(appId)
      res.json({ ok: true })
    }),
  )

  // The app's audit trail (data mutations + admin actions), newest-first.
  router.get(
    '/:appId/audit',
    safe(async (req, res) => {
      const { appId } = req.params
      const events = await auditRepo.listByApp(appId, { limit: 200 })
      res.json({ events })
    }),
  )

  return router
}
