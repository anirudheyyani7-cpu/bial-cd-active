import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  createAppDataRouter,
  makeAppDataLimiter,
  makeDataServiceCors,
  APP_DATA_BODY_LIMIT,
} from '../app-data.js'
import { createAppRegistryRepo } from '../app-registry-repo.js'
import { createDataRecordsRepo } from '../data-records-repo.js'
import { createAuditRepo } from '../audit-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'
import { makeFakeDataRecordsContainer } from './fakeDataRecordsCosmos.js'
import { makeFakeAuditContainer } from './fakeAuditCosmos.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const SEED = [
  { _id: 'app-open', appKey: 'key-open', status: 'approved', loginRequired: false, dataCount: 0, dataBytes: 0 },
  { _id: 'app-login', appKey: 'key-login', status: 'approved', loginRequired: true, dataCount: 0, dataBytes: 0 },
  { _id: 'app-draft', appKey: 'key-draft', status: 'draft', loginRequired: false, dataCount: 0, dataBytes: 0 },
  { _id: 'app-B', appKey: 'key-B', status: 'approved', loginRequired: false, dataCount: 0, dataBytes: 0 },
]

function harness({ seed = SEED, limiter } = {}) {
  const registryContainer = makeFakeAppRegistryContainer(seed)
  const registryRepo = createAppRegistryRepo(registryContainer)
  const dataContainer = makeFakeDataRecordsContainer([])
  const dataRecordsRepo = createDataRecordsRepo(dataContainer, registryRepo)
  const auditContainer = makeFakeAuditContainer([])
  const auditRepo = createAuditRepo(auditContainer)
  const app = express()
  // Mirror the server.js mount: scoped CORS + 256kb body cap on the /api/apps
  // prefix, then the records router (mergeParams exposes :appId).
  app.use('/api/apps', makeDataServiceCors())
  app.use('/api/apps', express.json({ limit: APP_DATA_BODY_LIMIT }))
  app.use('/api/apps/:appId/records', createAppDataRouter({ dataRecordsRepo, auditRepo, registryRepo }, { limiter }))
  return { app, registryContainer, dataContainer, auditContainer }
}

const token = (sub = 'alice') => signAccessToken({ sub, username: sub, role: 'user' })
const open = (app, method, path) => request(app)[method](`/api/apps/app-open${path}`).set('X-App-Key', 'key-open')

describe('app-data routes — CRUD round-trip', () => {
  it('create → list → get → update → delete, data intact, reserved fields ignored if sent', async () => {
    const { app } = harness()
    // reserved keys in `data` must be stripped, not stored
    const created = await open(app, 'post', '/records').send({ data: { title: 'Gate 4', _id: 'spoof', appId: 'evil' } })
    expect(created.status).toBe(201)
    expect(created.body.id).toBeTypeOf('string')
    expect(created.body.data).toEqual({ title: 'Gate 4' }) // reserved stripped
    expect(created.body.createdInDraft).toBe(false) // approved app
    const id = created.body.id

    const listed = await open(app, 'get', '/records')
    expect(listed.status).toBe(200)
    expect(listed.body.records.map((r) => r.id)).toContain(id)

    const got = await open(app, 'get', `/records/${id}`)
    expect(got.status).toBe(200)
    expect(got.body.record.data).toEqual({ title: 'Gate 4' })

    const patched = await open(app, 'patch', `/records/${id}`).send({ data: { status: 'done' } })
    expect(patched.status).toBe(200)
    expect(patched.body.record.data).toEqual({ title: 'Gate 4', status: 'done' }) // merge

    const removed = await open(app, 'delete', `/records/${id}`)
    expect(removed.status).toBe(200)
    expect(removed.body).toEqual({ ok: true })
    expect((await open(app, 'get', `/records/${id}`)).status).toBe(404) // gone
  })

  it('a draft app tags createdInDraft=true', async () => {
    const { app } = harness()
    const created = await request(app)
      .post('/api/apps/app-draft/records')
      .set('X-App-Key', 'key-draft')
      .send({ data: { x: 1 } })
    expect(created.status).toBe(201)
    expect(created.body.createdInDraft).toBe(true)
  })
})

describe('app-data routes — tenant isolation (write/read IDOR closed)', () => {
  it('app-open’s key cannot reach a record owned by app-B', async () => {
    const { app } = harness()
    const recB = await request(app).post('/api/apps/app-B/records').set('X-App-Key', 'key-B').send({ data: { secret: 1 } })
    const id = recB.body.id
    // app-open's key on app-B's URL → 404 (key/URL mismatch, no cross-app leak)
    expect((await request(app).get(`/api/apps/app-B/records/${id}`).set('X-App-Key', 'key-open')).status).toBe(404)
    // app-open's key on its OWN URL cannot see app-B's record (data-layer scope)
    expect((await open(app, 'get', `/records/${id}`)).status).toBe(404)
    expect((await open(app, 'patch', `/records/${id}`).send({ data: { secret: 2 } })).status).toBe(404)
    expect((await open(app, 'delete', `/records/${id}`)).status).toBe(404)
  })
})

describe('app-data routes — audit on mutation, never on read', () => {
  it('create/update/delete each append exactly one audit event with the right actor/action; reads do not', async () => {
    const { app, auditContainer } = harness()
    const created = await request(app)
      .post('/api/apps/app-login/records')
      .set('X-App-Key', 'key-login')
      .set('Authorization', `Bearer ${token('alice')}`)
      .send({ data: { a: 1 } })
    const id = created.body.id

    // reads add no audit events
    await request(app).get(`/api/apps/app-login/records/${id}`).set('X-App-Key', 'key-login').set('Authorization', `Bearer ${token('alice')}`)
    await request(app).get('/api/apps/app-login/records').set('X-App-Key', 'key-login').set('Authorization', `Bearer ${token('alice')}`)

    await request(app).patch(`/api/apps/app-login/records/${id}`).set('X-App-Key', 'key-login').set('Authorization', `Bearer ${token('alice')}`).send({ data: { a: 2 } })
    await request(app).delete(`/api/apps/app-login/records/${id}`).set('X-App-Key', 'key-login').set('Authorization', `Bearer ${token('alice')}`)

    const events = [...auditContainer._store.values()]
    expect(events.map((e) => e.action).sort()).toEqual(['create', 'delete', 'update'])
    for (const e of events) {
      expect(e.username).toBe('alice') // actor from the verified token
      expect(e.appId).toBe('app-login')
    }
    expect(events.find((e) => e.action === 'delete').recordId).toBe(id)
  })

  it('an open-app anonymous create records actor null in the audit', async () => {
    const { app, auditContainer } = harness()
    await open(app, 'post', '/records').send({ data: { a: 1 } })
    const event = [...auditContainer._store.values()][0]
    expect(event.action).toBe('create')
    expect(event.username).toBeNull() // anonymous
  })
})

describe('app-data routes — validation + body cap', () => {
  it('malformed/non-object data → 400; $/. keys → 400; bad collection → 400', async () => {
    const { app } = harness()
    expect((await open(app, 'post', '/records').send({ data: 'nope' })).status).toBe(400)
    expect((await open(app, 'post', '/records').send({ data: { $where: 'x' } })).status).toBe(400)
    expect((await open(app, 'post', '/records').send({ collection: 'bad/name', data: { a: 1 } })).status).toBe(400)
    const bad = await open(app, 'post', '/records').send({ data: 'nope' })
    expect(bad.body.error.message).toBeTypeOf('string') // uniform error shape
  })

  it('an oversize body → 413 (256kb cap)', async () => {
    const { app } = harness()
    const huge = 'x'.repeat(300 * 1024) // over the 256kb cap
    const res = await open(app, 'post', '/records').send({ data: { blob: huge } })
    expect(res.status).toBe(413)
  })
})

describe('app-data routes — login gate', () => {
  it('a loginRequired app rejects a write with no Bearer (401); an open app allows anonymous', async () => {
    const { app } = harness()
    expect((await request(app).post('/api/apps/app-login/records').set('X-App-Key', 'key-login').send({ data: { a: 1 } })).status).toBe(401)
    expect((await open(app, 'post', '/records').send({ data: { a: 1 } })).status).toBe(201)
  })
})

describe('app-data routes — per-app rate limit (keyed by appId)', () => {
  it('429s after the cap on one app while a different app keeps its own bucket', async () => {
    const { app } = harness({ limiter: makeAppDataLimiter({ windowMs: 60_000, limit: 2 }) })
    expect((await open(app, 'post', '/records').send({ data: { a: 1 } })).status).toBe(201)
    expect((await open(app, 'post', '/records').send({ data: { a: 2 } })).status).toBe(201)
    expect((await open(app, 'post', '/records').send({ data: { a: 3 } })).status).toBe(429) // app-open bucket full
    // app-B has its own bucket — unaffected (proves keying by appId, not a shared/IP bucket)
    const bOk = await request(app).post('/api/apps/app-B/records').set('X-App-Key', 'key-B').send({ data: { a: 1 } })
    expect(bOk.status).toBe(201)
  })

  it('the limiter is not reached before req.appCtx is set: a missing/bad key → 401, never 429', async () => {
    const { app } = harness({ limiter: makeAppDataLimiter({ windowMs: 60_000, limit: 1 }) })
    // Hammer with no key — requireAppKey 401s each one BEFORE the limiter could
    // collapse them into a bucket (no appCtx → the limiter never runs).
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).post('/api/apps/app-open/records').send({ data: { a: 1 } })).status).toBe(401)
    }
    // a real keyed request still gets its full allowance
    expect((await open(app, 'post', '/records').send({ data: { a: 1 } })).status).toBe(201)
  })
})

describe('app-data routes — CORS preflight for the opaque-origin iframe', () => {
  it('an OPTIONS preflight from Origin: null succeeds with the reflected origin', async () => {
    const { app } = harness()
    const res = await request(app)
      .options('/api/apps/app-open/records')
      .set('Origin', 'null')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-app-key,authorization,content-type')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('null')
  })
})
