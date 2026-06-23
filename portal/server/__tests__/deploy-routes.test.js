import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createDeployRouter } from '../deploy.js'
import { createAppRegistryRepo } from '../app-registry-repo.js'
import { createConversationsRepo } from '../conversations-repo.js'
import { createAuditRepo } from '../audit-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'
import { makeFakeConversationsContainer } from './fakeConversationsCosmos.js'
import { makeFakeAuditContainer } from './fakeAuditCosmos.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const builderHeader = (id, username, source) => ({
  _id: id,
  username,
  kind: 'builder',
  code: source ? { current: { source, entry: 'PreviewApp' } } : undefined,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

function harness({ conversations = [], registry = [] } = {}) {
  const conversationsRepo = createConversationsRepo(makeFakeConversationsContainer(conversations))
  const registryContainer = makeFakeAppRegistryContainer(registry)
  const registryRepo = createAppRegistryRepo(registryContainer)
  const auditContainer = makeFakeAuditContainer([])
  const auditRepo = createAuditRepo(auditContainer)
  const app = express()
  app.use(express.json())
  app.use('/api/apps', createDeployRouter({ registryRepo, conversationsRepo, auditRepo }))
  return { app, registryContainer, auditContainer }
}

const token = (sub) => signAccessToken({ sub, username: sub, role: 'user' })

describe('deploy — provision', () => {
  it('creates a draft + appKey and is idempotent (same appKey on a second call)', async () => {
    const { app } = harness({ conversations: [builderHeader('app-1', 'alice', 'function PreviewApp(){}')] })
    const first = await request(app).post('/api/apps/app-1/provision').set('Authorization', `Bearer ${token('alice')}`)
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ appId: 'app-1', status: 'draft', loginRequired: false })
    expect(first.body.appKey).toMatch(/^bial_/)
    const second = await request(app).post('/api/apps/app-1/provision').set('Authorization', `Bearer ${token('alice')}`)
    expect(second.body.appKey).toBe(first.body.appKey) // idempotent, no re-mint
  })

  it('a non-owner cannot provision another user’s build → 404 (never sees the appKey)', async () => {
    const { app } = harness({ conversations: [builderHeader('app-1', 'alice', 'function PreviewApp(){}')] })
    const res = await request(app).post('/api/apps/app-1/provision').set('Authorization', `Bearer ${token('mallory')}`)
    expect(res.status).toBe(404)
    expect(res.body.appKey).toBeUndefined()
  })

  it('no token → 401', async () => {
    const { app } = harness({ conversations: [builderHeader('app-1', 'alice', 'function PreviewApp(){}')] })
    expect((await request(app).post('/api/apps/app-1/provision')).status).toBe(401)
  })
})

describe('deploy — submit', () => {
  it('writes code.source from the build and sets pending; appends a submit audit event', async () => {
    const { app, registryContainer, auditContainer } = harness({
      conversations: [builderHeader('app-1', 'alice', 'function PreviewApp(){return <div>v1</div>}')],
    })
    const res = await request(app).post('/api/apps/app-1/submit').set('Authorization', `Bearer ${token('alice')}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ appId: 'app-1', status: 'pending' })
    const doc = registryContainer._get('app-1')
    expect(doc.status).toBe('pending')
    expect(doc.code.source.src).toContain('v1')
    expect([...auditContainer._store.values()][0].action).toBe('submit')
  })

  it('re-submit on an approved app returns it to pending, updates code.source, leaves approvedSnapshot unchanged', async () => {
    const { app, registryContainer } = harness({
      conversations: [builderHeader('app-2', 'alice', 'function PreviewApp(){return <div>v2</div>}')],
      registry: [
        {
          _id: 'app-2',
          appKey: 'k2',
          ownerUsername: 'alice',
          status: 'approved',
          loginRequired: false,
          code: { source: { src: 'v1', entry: 'PreviewApp' }, approvedSnapshot: { compiled: 'OLD_JS', src: 'v1' } },
          dataCount: 0,
          dataBytes: 0,
        },
      ],
    })
    const res = await request(app).post('/api/apps/app-2/submit').set('Authorization', `Bearer ${token('alice')}`)
    expect(res.status).toBe(200)
    const doc = registryContainer._get('app-2')
    expect(doc.status).toBe('pending') // re-review
    expect(doc.code.source.src).toContain('v2') // new code staged
    expect(doc.code.approvedSnapshot.compiled).toBe('OLD_JS') // runner keeps serving the old snapshot
  })

  it('submit with nothing generated → 400; non-owner → 404', async () => {
    const { app } = harness({
      conversations: [builderHeader('empty', 'alice', undefined), builderHeader('owned', 'alice', 'function PreviewApp(){}')],
    })
    expect((await request(app).post('/api/apps/empty/submit').set('Authorization', `Bearer ${token('alice')}`)).status).toBe(400)
    expect((await request(app).post('/api/apps/owned/submit').set('Authorization', `Bearer ${token('mallory')}`)).status).toBe(404)
  })
})

describe('deploy — owner status read (no provision)', () => {
  it('returns status:null for an un-provisioned build (and does NOT create a draft)', async () => {
    const { app, registryContainer } = harness({ conversations: [builderHeader('app-1', 'alice', 'function PreviewApp(){}')] })
    const res = await request(app).get('/api/apps/app-1/status').set('Authorization', `Bearer ${token('alice')}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ appId: 'app-1', status: null })
    expect(registryContainer._store.size).toBe(0) // read-only — no draft created (no sprawl)
  })

  it('returns the live status + appKey + rejectionNote for a provisioned build', async () => {
    const { app } = harness({
      conversations: [builderHeader('app-2', 'alice', 'function PreviewApp(){}')],
      registry: [{ _id: 'app-2', appKey: 'k2', ownerUsername: 'alice', status: 'rejected', loginRequired: true, rejectionNote: 'fix it', dataCount: 0, dataBytes: 0 }],
    })
    const res = await request(app).get('/api/apps/app-2/status').set('Authorization', `Bearer ${token('alice')}`)
    expect(res.body).toMatchObject({ appId: 'app-2', status: 'rejected', appKey: 'k2', loginRequired: true, rejectionNote: 'fix it' })
  })

  it('a non-owner cannot read another build’s status → 404', async () => {
    const { app } = harness({ conversations: [builderHeader('app-1', 'alice', 'function PreviewApp(){}')] })
    expect((await request(app).get('/api/apps/app-1/status').set('Authorization', `Bearer ${token('mallory')}`)).status).toBe(404)
  })
})
