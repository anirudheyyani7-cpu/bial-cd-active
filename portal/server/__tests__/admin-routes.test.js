import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAuth, requireAdmin } from '../auth/middleware.js'
import { createAdminRouter } from '../admin/routes.js'
import { createUsersRepo } from '../users-repo.js'
import { createFeedbackRepo } from '../feedback-repo.js'
import { makeFakeContainer } from './fakeCosmos.js'
import { makeFakeFeedbackContainer } from './fakeFeedbackCosmos.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const DEFAULTS = { dailyTokenLimit: 1000, contextSoftLimit: 100, contextHardLimit: 200 }

function doc(username, role = 'user', limits) {
  return {
    _id: username,
    username,
    email: `${username}@bial.test`,
    name: username.toUpperCase(),
    role,
    passwordHash: '$argon2id$v=19$secret',
    refreshTokenHash: 'should-not-leak',
    refreshTokenExpiresAt: '2026-02-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(limits && { limits }),
  }
}

function appWith(docs, feedbackDocs = []) {
  const repo = createUsersRepo(makeFakeContainer(docs))
  const feedbackContainer = makeFakeFeedbackContainer(feedbackDocs)
  const feedbackRepo = createFeedbackRepo(feedbackContainer)
  const app = express()
  app.use(express.json())
  app.use('/api/admin', requireAuth, requireAdmin, createAdminRouter({ repo, feedbackRepo, defaults: DEFAULTS }))
  return { app, repo, feedbackContainer }
}

const fdoc = (id, createdAt, extra = {}) => ({
  _id: id,
  username: 'staff@bial.test',
  message: `message ${id}`,
  page: '/chat',
  createdAt,
  ...extra,
})

const adminToken = () => signAccessToken({ sub: 'admin', username: 'admin', role: 'admin' })
const userToken = () => signAccessToken({ sub: 'bob', username: 'bob', role: 'user' })

describe('admin routes — gating', () => {
  it('no token → 401', async () => {
    const { app } = appWith([])
    expect((await request(app).get('/api/admin/users')).status).toBe(401)
  })

  it('non-admin token → 403', async () => {
    const { app } = appWith([doc('bob')])
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${userToken()}`)
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/admin/i)
  })

  it('admin token → 200', async () => {
    const { app } = appWith([doc('admin', 'admin')])
    expect((await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken()}`)).status).toBe(200)
  })
})

describe('GET /api/admin/users', () => {
  it('returns defaults + users with raw overrides and effective limits, never secrets', async () => {
    const { app } = appWith([
      doc('admin', 'admin'),
      doc('alice'),
      doc('rich', 'user', { dailyTokenLimit: 5000 }),
    ])
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.defaults).toEqual(DEFAULTS)

    const rich = res.body.users.find((u) => u.username === 'rich')
    expect(rich.limits).toEqual({ dailyTokenLimit: 5000 })
    expect(rich.effectiveLimits.dailyTokenLimit).toBe(5000) // override wins
    expect(rich.effectiveLimits.contextHardLimit).toBe(200) // default

    const alice = res.body.users.find((u) => u.username === 'alice')
    expect(alice.limits).toEqual({}) // no override
    expect(alice.effectiveLimits).toEqual(DEFAULTS)

    // No secret/session fields anywhere in the payload.
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('passwordHash')
    expect(raw).not.toContain('refreshTokenHash')
  })
})

describe('PATCH /api/admin/users/:username/limits', () => {
  it('sets an override and returns the new effective limits', async () => {
    const { app, repo } = appWith([doc('admin', 'admin'), doc('alice')])
    const res = await request(app)
      .patch('/api/admin/users/alice/limits')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ dailyTokenLimit: 7000 })
    expect(res.status).toBe(200)
    expect(res.body.effectiveLimits.dailyTokenLimit).toBe(7000)
    expect((await repo.findByUsername('alice')).limits.dailyTokenLimit).toBe(7000)
  })

  it('clears an override with null → reverts to default', async () => {
    const { app, repo } = appWith([doc('admin', 'admin'), doc('rich', 'user', { dailyTokenLimit: 5000 })])
    const res = await request(app)
      .patch('/api/admin/users/rich/limits')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ dailyTokenLimit: null })
    expect(res.status).toBe(200)
    expect(res.body.effectiveLimits.dailyTokenLimit).toBe(DEFAULTS.dailyTokenLimit)
    expect((await repo.findByUsername('rich')).limits?.dailyTokenLimit).toBeUndefined()
  })

  it('400 on an invalid body (non-positive)', async () => {
    const { app } = appWith([doc('admin', 'admin'), doc('alice')])
    const res = await request(app)
      .patch('/api/admin/users/alice/limits')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ dailyTokenLimit: 0 })
    expect(res.status).toBe(400)
  })

  it('400 when soft >= hard', async () => {
    const { app } = appWith([doc('admin', 'admin'), doc('alice')])
    const res = await request(app)
      .patch('/api/admin/users/alice/limits')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ contextSoftLimit: 100, contextHardLimit: 100 })
    expect(res.status).toBe(400)
  })

  it('404 for an unknown user', async () => {
    const { app } = appWith([doc('admin', 'admin')])
    const res = await request(app)
      .patch('/api/admin/users/ghost/limits')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ dailyTokenLimit: 7000 })
    expect(res.status).toBe(404)
  })

  it('non-admin cannot PATCH (403)', async () => {
    const { app } = appWith([doc('bob'), doc('alice')])
    const res = await request(app)
      .patch('/api/admin/users/alice/limits')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ dailyTokenLimit: 7000 })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/admin/feedback', () => {
  it('no token → 401', async () => {
    const { app } = appWith([])
    expect((await request(app).get('/api/admin/feedback')).status).toBe(401)
  })

  it('non-admin token → 403 with an admin-required message', async () => {
    const { app } = appWith([doc('bob')])
    const res = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${userToken()}`)
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/admin/i)
  })

  it('admin token → 200 with feedback newest-first and a total', async () => {
    const { app } = appWith(
      [doc('admin', 'admin')],
      [
        fdoc('a', '2026-06-18T09:00:00.000Z'),
        fdoc('b', '2026-06-18T10:00:00.000Z'),
        fdoc('c', '2026-06-18T11:00:00.000Z'),
      ],
    )
    const res = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(3)
    expect(res.body.feedback.map((f) => f.message)).toEqual(['message c', 'message b', 'message a'])
  })

  it('each row carries only username, message, page, createdAt — no _id or extras', async () => {
    const { app } = appWith(
      [doc('admin', 'admin')],
      [fdoc('a', '2026-06-18T09:00:00.000Z', { secret: 'should-not-leak', _internal: 1 })],
    )
    const res = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body.feedback[0]).sort()).toEqual(['createdAt', 'message', 'page', 'username'])
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('should-not-leak')
    expect(raw).not.toContain('_id')
  })

  it('caps the list at 200 while total reflects the true count', async () => {
    const many = Array.from({ length: 205 }, (_, i) =>
      fdoc(`id-${String(i).padStart(3, '0')}`, `2026-06-18T00:00:00.${String(i).padStart(3, '0')}Z`),
    )
    const { app } = appWith([doc('admin', 'admin')], many)
    const res = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.feedback).toHaveLength(200)
    expect(res.body.total).toBe(205)
  })

  it('empty collection → 200 { feedback: [], total: 0 }', async () => {
    const { app } = appWith([doc('admin', 'admin')], [])
    const res = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ feedback: [], total: 0 })
  })

  it('500 with a generic message when the repo throws (no raw error leak)', async () => {
    const repo = createUsersRepo(makeFakeContainer([doc('admin', 'admin')]))
    const feedbackRepo = {
      listFeedback: async () => {
        throw new Error('cosmos blew up with secret detail')
      },
      countFeedback: async () => 0,
    }
    const app = express()
    app.use(express.json())
    app.use('/api/admin', requireAuth, requireAdmin, createAdminRouter({ repo, feedbackRepo, defaults: DEFAULTS }))
    const res = await request(app).get('/api/admin/feedback').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(500)
    expect(res.body.error.message).toBe('Failed to load feedback.')
    expect(JSON.stringify(res.body)).not.toContain('secret detail')
  })
})

describe('createAdminRouter dependency guards', () => {
  it('throws when repo is omitted', () => {
    expect(() => createAdminRouter({})).toThrow(/repo is required/)
  })

  it('throws when feedbackRepo is omitted', () => {
    const repo = createUsersRepo(makeFakeContainer([]))
    expect(() => createAdminRouter({ repo, defaults: DEFAULTS })).toThrow(/feedbackRepo is required/)
  })
})
