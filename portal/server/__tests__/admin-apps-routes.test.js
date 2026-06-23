import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAuth, requireAdmin } from '../auth/middleware.js'
import { createAdminAppsRouter } from '../admin/apps-routes.js'
import { createAppRegistryRepo } from '../app-registry-repo.js'
import { createAuditRepo } from '../audit-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'
import { makeFakeAuditContainer } from './fakeAuditCosmos.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const VALID_JSX = 'function PreviewApp(){ return <div className="x">hello</div> }'
const BROKEN_JSX = 'function PreviewApp(){ return <div>oops </ }' // unbalanced JSX

const pendingApp = (id, src = VALID_JSX) => ({
  _id: id,
  appKey: `k_${id}`,
  ownerUsername: 'alice',
  status: 'pending',
  loginRequired: false,
  code: { source: { src, entry: 'PreviewApp' } },
  dataCount: 0,
  dataBytes: 0,
})

function harness(registry = []) {
  const registryContainer = makeFakeAppRegistryContainer(registry)
  const registryRepo = createAppRegistryRepo(registryContainer)
  const auditContainer = makeFakeAuditContainer([])
  const auditRepo = createAuditRepo(auditContainer)
  const app = express()
  app.use(express.json())
  app.use('/api/admin/apps', requireAuth, requireAdmin, createAdminAppsRouter({ registryRepo, auditRepo }))
  return { app, registryContainer, auditContainer }
}

const adminTok = () => signAccessToken({ sub: 'admin', username: 'admin', role: 'admin' })
const userTok = () => signAccessToken({ sub: 'alice', username: 'alice', role: 'user' })

describe('admin apps — approve', () => {
  it('compiles + snapshots the source, sets approvedBy/at, audits, and goes approved', async () => {
    const { app, registryContainer, auditContainer } = harness([pendingApp('app-1')])
    const res = await request(app).post('/api/admin/apps/app-1/approve').set('Authorization', `Bearer ${adminTok()}`)
    expect(res.status).toBe(200)
    const doc = registryContainer._get('app-1')
    expect(doc.status).toBe('approved')
    expect(doc.approvedBy).toBe('admin')
    expect(doc.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(doc.code.approvedSnapshot.compiled).toContain('React.createElement') // pre-compiled, no JSX
    expect(doc.code.approvedSnapshot.by).toBe('admin')
    expect([...auditContainer._store.values()][0].action).toBe('approve')
  })

  it('a snapshot that fails to compile → 422 and leaves the status unchanged', async () => {
    const { app, registryContainer } = harness([pendingApp('broken', BROKEN_JSX)])
    const res = await request(app).post('/api/admin/apps/broken/approve').set('Authorization', `Bearer ${adminTok()}`)
    expect(res.status).toBe(422)
    expect(registryContainer._get('broken').status).toBe('pending') // unchanged
    expect(registryContainer._get('broken').code.approvedSnapshot).toBeUndefined()
  })

  it('approving a non-pending app → 409; an unknown app → 404', async () => {
    const { app } = harness([{ ...pendingApp('approved-already'), status: 'approved' }])
    expect((await request(app).post('/api/admin/apps/approved-already/approve').set('Authorization', `Bearer ${adminTok()}`)).status).toBe(409)
    expect((await request(app).post('/api/admin/apps/ghost/approve').set('Authorization', `Bearer ${adminTok()}`)).status).toBe(404)
  })
})

describe('admin apps — reject', () => {
  it('sets rejected + note and audits the action', async () => {
    const { app, registryContainer, auditContainer } = harness([pendingApp('app-1')])
    const res = await request(app)
      .post('/api/admin/apps/app-1/reject')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ note: 'Please remove the hardcoded sample rows.' })
    expect(res.status).toBe(200)
    const doc = registryContainer._get('app-1')
    expect(doc.status).toBe('rejected')
    expect(doc.rejectionNote).toMatch(/hardcoded sample/)
    expect([...auditContainer._store.values()][0].action).toBe('reject')
  })

  it('rejecting a non-pending app → 409', async () => {
    const { app } = harness([{ ...pendingApp('drafty'), status: 'draft' }])
    expect((await request(app).post('/api/admin/apps/drafty/reject').set('Authorization', `Bearer ${adminTok()}`)).status).toBe(409)
  })
})

describe('admin apps — authorization', () => {
  it('a non-admin gets 403 on approve and reject', async () => {
    const { app } = harness([pendingApp('app-1')])
    expect((await request(app).post('/api/admin/apps/app-1/approve').set('Authorization', `Bearer ${userTok()}`)).status).toBe(403)
    expect((await request(app).post('/api/admin/apps/app-1/reject').set('Authorization', `Bearer ${userTok()}`)).status).toBe(403)
  })

  it('no token → 401', async () => {
    const { app } = harness([pendingApp('app-1')])
    expect((await request(app).post('/api/admin/apps/app-1/approve')).status).toBe(401)
  })
})
