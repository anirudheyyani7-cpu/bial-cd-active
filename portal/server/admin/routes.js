/**
 * Admin routes — per-user usage-limit management, mounted at /api/admin.
 *
 * The whole router sits behind requireAuth + requireAdmin (applied at the mount
 * point in server.js), so every handler can assume a verified admin caller.
 *
 *  - GET   /users                  → list users with raw overrides + effective
 *                                    limits (never returns secrets — listUsers
 *                                    projects them out).
 *  - PATCH /users/:username/limits → set/clear a user's limit overrides; returns
 *                                    the user's new effective limits.
 *
 * `repo` and the standard-plan `defaults` are injected so the router is testable
 * against a fake users-repo without live Cosmos.
 */
import express from 'express'
import { resolveUserLimits, validateLimitsPatch, defaultLimits } from '../limits.js'

export function createAdminRouter({ repo, defaults = defaultLimits() } = {}) {
  if (!repo) throw new Error('createAdminRouter: repo is required')
  const router = express.Router()

  router.get('/users', async (_req, res) => {
    try {
      const users = await repo.listUsers()
      return res.json({
        // The standard plan, so the UI can label un-overridden fields and
        // prefill the "use default" inputs.
        defaults: resolveUserLimits(null, defaults),
        users: users.map((u) => ({
          username: u.username,
          name: u.name,
          role: u.role,
          limits: u.limits || {}, // raw overrides (sparse) — drives the "default" flags
          effectiveLimits: resolveUserLimits(u, defaults), // resolved (what's enforced/shown)
        })),
      })
    } catch (err) {
      console.error('admin listUsers failed:', err.message)
      return res.status(500).json({ error: { message: 'Failed to load users.' } })
    }
  })

  router.patch('/users/:username/limits', async (req, res) => {
    const { username } = req.params
    const result = validateLimitsPatch(req.body)
    if (!result.ok) {
      return res.status(400).json({ error: { message: result.error } })
    }
    try {
      const user = await repo.findByUsername(username)
      if (!user) {
        return res.status(404).json({ error: { message: `No such user: ${username}` } })
      }
      await repo.updateLimits(username, result.limits)
      // Re-read so the response reflects the persisted state (handles clears).
      const updated = await repo.findByUsername(username)
      return res.json({
        username,
        limits: updated?.limits || {},
        effectiveLimits: resolveUserLimits(updated, defaults),
      })
    } catch (err) {
      console.error('admin updateLimits failed:', err.message)
      return res.status(500).json({ error: { message: 'Failed to update limits.' } })
    }
  })

  return router
}
