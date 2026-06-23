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
import { compileJsx } from '../jsx-compile.js'

const MAX_NOTE = 1000

const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('admin apps route error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: { message: 'Request failed. Please retry.' } })
  }
}

export function createAdminAppsRouter({ registryRepo, auditRepo, dataRecordsRepo, conversationsRepo } = {}) {
  if (!registryRepo) throw new Error('createAdminAppsRouter: registryRepo is required')
  if (!auditRepo) throw new Error('createAdminAppsRouter: auditRepo is required')
  // dataRecordsRepo + conversationsRepo are used by the U10 routes (clear-data /
  // delete); accepted here so the mount never has to change.
  const router = express.Router()

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

  return router
}
