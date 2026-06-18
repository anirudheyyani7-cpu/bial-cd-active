import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAuth } from '../auth/middleware.js'
import { createFeedbackHandler, makeFeedbackLimiter } from '../feedback.js'
import { createFeedbackRepo } from '../feedback-repo.js'
import { makeFakeFeedbackContainer } from './fakeFeedbackCosmos.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

/** Mount the handler behind requireAuth (the limiter is exercised separately). */
function appWith(repo) {
  const container = makeFakeFeedbackContainer([])
  const resolved = repo ?? createFeedbackRepo(container)
  const app = express()
  app.use(express.json())
  app.post('/api/feedback', requireAuth, createFeedbackHandler(resolved))
  return { app, container }
}

const token = (sub = 'alice@bial.test') => signAccessToken({ sub, username: sub, role: 'user' })

describe('POST /api/feedback', () => {
  it('happy path: 201 and persists one doc whose author is the TOKEN sub (not the body)', async () => {
    const { app, container } = appWith()
    const res = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${token('alice@bial.test')}`)
      // A malicious body username must be ignored — author comes from the token.
      .send({ message: 'The export button does nothing', page: '/chat', username: 'attacker@evil.test' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ ok: true })

    const docs = [...container._store.values()]
    expect(docs).toHaveLength(1)
    expect(docs[0].username).toBe('alice@bial.test')
    expect(docs[0].message).toBe('The export button does nothing')
    expect(docs[0].page).toBe('/chat')
    expect(typeof docs[0]._id).toBe('string')
    expect(docs[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('no token → 401, nothing persisted', async () => {
    const { app, container } = appWith()
    const res = await request(app).post('/api/feedback').send({ message: 'hi' })
    expect(res.status).toBe(401)
    expect(container._store.size).toBe(0)
  })

  it('empty message → 400 with an error message, nothing persisted', async () => {
    const { app, container } = appWith()
    const res = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${token()}`)
      .send({ message: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBeTypeOf('string')
    expect(container._store.size).toBe(0)
  })

  it('oversized message → 400, nothing persisted', async () => {
    const { app, container } = appWith()
    const res = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${token()}`)
      .send({ message: 'a'.repeat(4001) })
    expect(res.status).toBe(400)
    expect(container._store.size).toBe(0)
  })

  it('captures the page from the body; an absent page stores ""', async () => {
    const { app, container } = appWith()
    await request(app).post('/api/feedback').set('Authorization', `Bearer ${token()}`).send({ message: 'a', page: '/chat' })
    await request(app).post('/api/feedback').set('Authorization', `Bearer ${token()}`).send({ message: 'b' })
    const pages = [...container._store.values()].map((d) => d.page).sort()
    expect(pages).toEqual(['', '/chat'])
  })

  it('repo failure → 500 with a generic message that does not leak the raw error', async () => {
    const failingRepo = {
      addFeedback: async () => {
        throw new Error('cosmos connection exploded with secret detail')
      },
    }
    const { app, container } = appWith(failingRepo)
    const res = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${token()}`)
      .send({ message: 'hi' })
    expect(res.status).toBe(500)
    expect(res.body.error.message).toBe('Failed to submit feedback.')
    expect(JSON.stringify(res.body)).not.toContain('cosmos connection exploded')
    expect(container._store.size).toBe(0)
  })
})

// Mounts the REAL makeFeedbackLimiter (with a tiny injected limit) behind
// requireAuth, mirroring auth-routes.test.js's limiter coverage. This is the
// "exercised separately" the handler-only suite above refers to.
describe('POST /api/feedback — rate limiting (makeFeedbackLimiter)', () => {
  function limitedApp(limit) {
    const container = makeFakeFeedbackContainer([])
    const app = express()
    app.use(express.json())
    app.post(
      '/api/feedback',
      requireAuth,
      makeFeedbackLimiter({ windowMs: 60_000, limit }),
      createFeedbackHandler(createFeedbackRepo(container)),
    )
    return { app, container }
  }

  it('returns 429 { error: { message } } once a user exceeds the limit', async () => {
    const { app } = limitedApp(2)
    const post = () => request(app).post('/api/feedback').set('Authorization', `Bearer ${token()}`).send({ message: 'hi' })
    expect((await post()).status).toBe(201)
    expect((await post()).status).toBe(201)
    const blocked = await post()
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.message).toBeTypeOf('string')
  })

  it('keys per user+IP: one throttled user does not block a different user on the same IP', async () => {
    const { app } = limitedApp(1)
    const postAs = (sub) =>
      request(app).post('/api/feedback').set('Authorization', `Bearer ${token(sub)}`).send({ message: 'hi' })
    // alice exhausts her single allowance...
    expect((await postAs('alice@bial.test')).status).toBe(201)
    expect((await postAs('alice@bial.test')).status).toBe(429)
    // ...but bob (same supertest IP) still has his own bucket — proves per-user keying,
    // NOT a shared 'anon':IP bucket (the org-lockout failure mode Decision 6 warns about).
    expect((await postAs('bob@bial.test')).status).toBe(201)
  })
})
