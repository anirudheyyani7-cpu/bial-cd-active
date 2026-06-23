/**
 * Deploy lifecycle — OWNER-facing provision + submit (Decisions 7, 8, 9).
 *
 * `POST /api/apps/:appId/provision` mints the registry draft (idempotent) so a
 * build can read/write data WHILE building, and returns `{ appId, appKey,
 * loginRequired, status }` for the preview to inject. `POST /api/apps/:appId/submit`
 * snapshots the build's current code into `code.source` and moves the app to
 * `pending` for admin review.
 *
 * `appId` IS the builder conversation uuid (a clean 1:1 build↔app mapping), so
 * ownership is the CONVERSATION's ownership: every route resolves the header via
 * `conversationsRepo.getHeader(appId, req.user.sub)` and 404s a non-owner — a user
 * can neither provision (and read the appKey of) nor submit someone else's build.
 * Both routes sit behind the shared portal `requireAuth`.
 *
 * Submit ALWAYS lands on `pending` (a re-submit on an approved app returns it to
 * pending while the runner keeps serving the prior `approvedSnapshot` until a
 * fresh admin approval). Admin approve/reject live in admin/apps-routes.js.
 */
import { Router } from 'express'
import { requireAuth } from './auth/middleware.js'

const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('deploy route error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: { message: 'Request failed. Please retry.' } })
  }
}

export function createDeployRouter({ registryRepo, conversationsRepo, auditRepo }) {
  if (!registryRepo) throw new Error('createDeployRouter: registryRepo is required')
  if (!conversationsRepo) throw new Error('createDeployRouter: conversationsRepo is required')
  if (!auditRepo) throw new Error('createDeployRouter: auditRepo is required')
  const router = Router()

  // Resolve the owned build header, or null (not found / not the owner).
  const ownedBuild = (appId, username) => conversationsRepo.getHeader(appId, username)

  // Provision (idempotent): mint the draft + appKey on first call. Ownership is
  // the conversation's — a non-owner 404s and never sees the appKey.
  router.post(
    '/:appId/provision',
    requireAuth,
    safe(async (req, res) => {
      const owner = req.user.sub
      const { appId } = req.params
      const build = await ownedBuild(appId, owner)
      if (!build) return res.status(404).json({ error: { message: 'Build not found.' } })
      const doc = await registryRepo.ensureDraft(appId, owner)
      // Defensive: the conversation owns the appId 1:1, so this should always hold.
      if (doc.ownerUsername !== owner) return res.status(403).json({ error: { message: 'This app belongs to another user.' } })
      res.status(201).json({ appId, appKey: doc.appKey, loginRequired: Boolean(doc.loginRequired), status: doc.status })
    }),
  )

  // Submit for deployment: snapshot the build's code.current into code.source and
  // move to pending. Always pending (re-submit on approved → pending; the runner
  // keeps serving the prior approvedSnapshot until re-approval).
  router.post(
    '/:appId/submit',
    requireAuth,
    safe(async (req, res) => {
      const owner = req.user.sub
      const { appId } = req.params
      const build = await ownedBuild(appId, owner)
      if (!build) return res.status(404).json({ error: { message: 'Build not found.' } })
      const current = build.code?.current
      if (!current || typeof current.source !== 'string' || current.source.length === 0) {
        return res.status(400).json({ error: { message: 'Nothing to submit — generate an app first.' } })
      }

      const draft = await registryRepo.ensureDraft(appId, owner)
      if (draft.ownerUsername !== owner) return res.status(403).json({ error: { message: 'This app belongs to another user.' } })

      await registryRepo.setSnapshots(appId, {
        source: { src: current.source, entry: current.entry || 'PreviewApp', at: new Date().toISOString() },
      })
      // Only transition if not already pending (a pending→pending re-submit just
      // refreshes code.source above and stays pending — not an error).
      if (draft.status !== 'pending') {
        const moved = await registryRepo.setStatus(appId, 'pending')
        if (!moved.ok) {
          return res.status(409).json({ error: { message: 'This app cannot be submitted in its current state.' } })
        }
      }
      await auditRepo.record({ appId, username: owner, action: 'submit' })
      res.json({ appId, status: 'pending' })
    }),
  )

  return router
}
