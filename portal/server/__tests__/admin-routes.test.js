import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAuth, requireAdmin } from '../auth/middleware.js'
import { createAdminRouter } from '../admin/routes.js'
import { createUsersRepo } from '../users-repo.js'
import { makeFakeContainer } from './fakeCosmos.js'
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

function appWith(docs) {
  const repo = createUsersRepo(makeFakeContainer(docs))
  const app = express()
  app.use(express.json())
  app.use('/api/admin', requireAuth, requireAdmin, createAdminRouter({ repo, defaults: DEFAULTS }))
  return { app, repo }
}

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
