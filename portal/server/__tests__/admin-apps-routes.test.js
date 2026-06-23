import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAuth, requireAdmin } from '../auth/middleware.js'
import { createAdminAppsRouter } from '../admin/apps-routes.js'
import { createAppRegistryRepo } from '../app-registry-repo.js'
import { createAuditRepo } from '../audit-repo.js'
import { createDataRecordsRepo } from '../data-records-repo.js'
import { createAppFilesRepo } from '../app-files-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'
import { makeFakeAuditContainer } from './fakeAuditCosmos.js'
import { makeFakeDataRecordsContainer } from './fakeDataRecordsCosmos.js'
import { makeFakeAppFilesContainer } from './fakeAppFilesCosmos.js'
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

function harness(registry = [], records = [], files = []) {
  const registryContainer = makeFakeAppRegistryContainer(registry)
  const registryRepo = createAppRegistryRepo(registryContainer)
  const auditContainer = makeFakeAuditContainer([])
  const auditRepo = createAuditRepo(auditContainer)
  const dataContainer = makeFakeDataRecordsContainer(records)
  const dataRecordsRepo = createDataRecordsRepo(dataContainer, registryRepo)
  const filesContainer = makeFakeAppFilesContainer(files)
  const appFilesRepo = createAppFilesRepo(filesContainer, registryRepo)
  // Spy ObjectStore: each blob delete records the key AND whether the registry doc was
  // still present at delete time (so a test can prove blob purge precedes registry delete).
  const store = {
    calls: { delete: [] },
    async delete(key) {
      const appId = String(key).split('/')[1]
      store.calls.delete.push({ key, registryPresent: registryContainer._get(appId) !== undefined })
    },
    async put() {},
    async get() {},
    async exists() { return false },
    async getDownloadUrl() { return 'https://example/sas' },
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/api/admin/apps',
    requireAuth,
    requireAdmin,
    createAdminAppsRouter({ registryRepo, auditRepo, dataRecordsRepo, appFilesRepo, objectStore: store }),
  )
  return { app, registryContainer, auditContainer, dataContainer, filesContainer, store }
}

const fileDoc = (id, appId, createdInDraft, { status = 'ready', size = 100, createdAt = '2026-01-01T00:00:00.000Z' } = {}) => ({
  _id: id,
  appId,
  collection: 'default',
  filename: `${id}.csv`,
  contentType: 'text/csv',
  size,
  blobKey: `apps/${appId}/${id}`,
  status,
  createdBy: null,
  createdInDraft,
  createdAt,
  updatedAt: createdAt,
})

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

const approvedApp = (id, extra = {}) => ({
  _id: id,
  appKey: `k_${id}`,
  ownerUsername: 'alice',
  status: 'approved',
  loginRequired: false,
  dataCount: 0,
  dataBytes: 0,
  code: { approvedSnapshot: { compiled: 'JS', src: 'x' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})
const rec = (id, appId, createdInDraft, bytes = 10) => ({
  _id: id,
  appId,
  collection: 'default',
  data: { n: id },
  createdBy: null,
  createdInDraft,
  bytes,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('admin apps — list / patch / disable / enable (U10)', () => {
  it('GET /apps lists projected apps and filters by status (no code blobs / app key)', async () => {
    const { app } = harness([approvedApp('a1'), { ...pendingApp('p1') }])
    const all = await request(app).get('/api/admin/apps').set('Authorization', `Bearer ${adminTok()}`)
    expect(all.status).toBe(200)
    expect(all.body.apps).toHaveLength(2)
    expect(all.body.apps[0]).not.toHaveProperty('appKey')
    expect(all.body.apps[0]).not.toHaveProperty('code')
    const pending = await request(app).get('/api/admin/apps?status=pending').set('Authorization', `Bearer ${adminTok()}`)
    expect(pending.body.apps.map((a) => a.appId)).toEqual(['p1'])
  })

  it('PATCH loginRequired flip is audited (config:loginRequired); name patch is not', async () => {
    const { app, registryContainer, auditContainer } = harness([approvedApp('a1')])
    await request(app).patch('/api/admin/apps/a1').set('Authorization', `Bearer ${adminTok()}`).send({ name: 'Gate Tool' })
    expect(registryContainer._get('a1').name).toBe('Gate Tool')
    expect([...auditContainer._store.values()]).toHaveLength(0) // a name change is not audited

    await request(app).patch('/api/admin/apps/a1').set('Authorization', `Bearer ${adminTok()}`).send({ loginRequired: true })
    expect(registryContainer._get('a1').loginRequired).toBe(true)
    const events = [...auditContainer._store.values()]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'config:loginRequired', count: 1 })
  })

  it('disable (approved→disabled) and enable (disabled→approved) transition + audit', async () => {
    const { app, registryContainer, auditContainer } = harness([approvedApp('a1')])
    expect((await request(app).post('/api/admin/apps/a1/disable').set('Authorization', `Bearer ${adminTok()}`)).status).toBe(200)
    expect(registryContainer._get('a1').status).toBe('disabled')
    expect((await request(app).post('/api/admin/apps/a1/enable').set('Authorization', `Bearer ${adminTok()}`)).status).toBe(200)
    expect(registryContainer._get('a1').status).toBe('approved')
    expect([...auditContainer._store.values()].map((e) => e.action).sort()).toEqual(['disable', 'enable'])
  })

  it('enable on a PENDING app → 409 (cannot bypass the approve/compile gate)', async () => {
    const { app, registryContainer } = harness([pendingApp('p1')])
    const res = await request(app).post('/api/admin/apps/p1/enable').set('Authorization', `Bearer ${adminTok()}`)
    expect(res.status).toBe(409)
    // the only path to 'approved' is the approve route (compile + snapshot) — enable
    // must NOT promote an un-compiled pending app.
    expect(registryContainer._get('p1').status).toBe('pending')
  })
})

describe('admin apps — two-step clear-data + delete + audit (U10)', () => {
  it('data-summary mints a single-use token; clear-data purges, zeroes counters, and audits the count', async () => {
    const { app, registryContainer, auditContainer } = harness(
      [approvedApp('a1', { dataCount: 2, dataBytes: 20 })],
      [rec('r1', 'a1', true), rec('r2', 'a1', false)],
    )
    const summary = await request(app).get('/api/admin/apps/a1/data-summary').set('Authorization', `Bearer ${adminTok()}`)
    expect(summary.body).toMatchObject({ dataCount: 2, dataBytes: 20 })
    const token = summary.body.confirmToken
    expect(token).toBeTypeOf('string')

    const cleared = await request(app).post('/api/admin/apps/a1/clear-data').set('Authorization', `Bearer ${adminTok()}`).send({ confirmToken: token })
    expect(cleared.body).toEqual({ appId: 'a1', removed: 2, filesRemoved: 0 })
    expect(registryContainer._get('a1').dataCount).toBe(0) // counters zeroed
    expect([...auditContainer._store.values()].find((e) => e.action === 'clear-data').count).toBe(2)

    // the token is single-use → a replay is rejected
    const replay = await request(app).post('/api/admin/apps/a1/clear-data').set('Authorization', `Bearer ${adminTok()}`).send({ confirmToken: token })
    expect(replay.status).toBe(400)
  })

  it('clear-data without a valid token → 400 (nothing purged)', async () => {
    const { app, dataContainer } = harness([approvedApp('a1', { dataCount: 1 })], [rec('r1', 'a1', true)])
    const res = await request(app).post('/api/admin/apps/a1/clear-data').set('Authorization', `Bearer ${adminTok()}`).send({ confirmToken: 'forged' })
    expect(res.status).toBe(400)
    expect(dataContainer._store.size).toBe(1) // untouched
  })

  it('createdInDraftOnly purges only build-time test rows', async () => {
    const { app, dataContainer } = harness(
      [approvedApp('a1', { dataCount: 3, dataBytes: 30 })],
      [rec('d1', 'a1', true), rec('d2', 'a1', true), rec('live', 'a1', false)],
    )
    const token = (await request(app).get('/api/admin/apps/a1/data-summary').set('Authorization', `Bearer ${adminTok()}`)).body.confirmToken
    const res = await request(app).post('/api/admin/apps/a1/clear-data').set('Authorization', `Bearer ${adminTok()}`).send({ confirmToken: token, createdInDraftOnly: true })
    expect(res.body.removed).toBe(2)
    expect([...dataContainer._store.keys()]).toEqual(['live']) // only the live row remains
  })

  it('DELETE writes a final app:delete audit event, purges data, and removes the registry doc', async () => {
    const { app, registryContainer, auditContainer, dataContainer } = harness(
      [approvedApp('a1', { dataCount: 1, dataBytes: 10 })],
      [rec('r1', 'a1', false)],
    )
    const res = await request(app).delete('/api/admin/apps/a1').set('Authorization', `Bearer ${adminTok()}`)
    expect(res.body).toEqual({ ok: true })
    expect(registryContainer._get('a1')).toBeUndefined() // registry doc gone
    expect(dataContainer._store.size).toBe(0) // data purged
    expect([...auditContainer._store.values()].find((e) => e.action === 'app:delete')).toBeTruthy()
  })

  it('GET /apps/:id/audit returns the app’s event trail', async () => {
    const { app } = harness([approvedApp('a1')])
    await request(app).post('/api/admin/apps/a1/disable').set('Authorization', `Bearer ${adminTok()}`)
    const res = await request(app).get('/api/admin/apps/a1/audit').set('Authorization', `Bearer ${adminTok()}`)
    expect(res.status).toBe(200)
    expect(res.body.events.map((e) => e.action)).toContain('disable')
  })

  it('a non-admin is blocked from the management routes (403)', async () => {
    const { app } = harness([approvedApp('a1')])
    expect((await request(app).get('/api/admin/apps').set('Authorization', `Bearer ${userTok()}`)).status).toBe(403)
    expect((await request(app).delete('/api/admin/apps/a1').set('Authorization', `Bearer ${userTok()}`)).status).toBe(403)
  })
})

describe('admin apps — file lifecycle (U7: quota visibility, clear-files, purge-on-delete, recompute)', () => {
  it('createAdminAppsRouter fails loud when appFilesRepo or objectStore is omitted', () => {
    const reg = createAppRegistryRepo(makeFakeAppRegistryContainer([]))
    const aud = createAuditRepo(makeFakeAuditContainer([]))
    const data = createDataRecordsRepo(makeFakeDataRecordsContainer([]), reg)
    const files = createAppFilesRepo(makeFakeAppFilesContainer([]), reg)
    expect(() => createAdminAppsRouter({ registryRepo: reg, auditRepo: aud, dataRecordsRepo: data, objectStore: {} })).toThrow(/appFilesRepo is required/)
    expect(() => createAdminAppsRouter({ registryRepo: reg, auditRepo: aud, dataRecordsRepo: data, appFilesRepo: files })).toThrow(/objectStore is required/)
  })

  it('projectApp + data-summary surface fileCount/fileBytes alongside the record quota', async () => {
    const { app } = harness([approvedApp('a1', { dataCount: 2, dataBytes: 20, fileCount: 3, fileBytes: 4096 })])
    const list = await request(app).get('/api/admin/apps?status=approved').set('Authorization', `Bearer ${adminTok()}`)
    expect(list.body.apps[0]).toMatchObject({ fileCount: 3, fileBytes: 4096 })
    const summary = await request(app).get('/api/admin/apps/a1/data-summary').set('Authorization', `Bearer ${adminTok()}`)
    expect(summary.body).toMatchObject({ dataCount: 2, dataBytes: 20, fileCount: 3, fileBytes: 4096 })
  })

  it('clear-data purges file METADATA and DELETEs each blob, adjusts counters, and audits file:clear', async () => {
    const { app, registryContainer, filesContainer, auditContainer, store } = harness(
      [approvedApp('a1', { dataCount: 0, dataBytes: 0, fileCount: 2, fileBytes: 200 })],
      [],
      [fileDoc('f1', 'a1', true), fileDoc('f2', 'a1', false)],
    )
    const token = (await request(app).get('/api/admin/apps/a1/data-summary').set('Authorization', `Bearer ${adminTok()}`)).body.confirmToken
    const res = await request(app).post('/api/admin/apps/a1/clear-data').set('Authorization', `Bearer ${adminTok()}`).send({ confirmToken: token })
    expect(res.body).toEqual({ appId: 'a1', removed: 0, filesRemoved: 2 })
    expect(filesContainer._store.size).toBe(0) // metadata gone
    expect(store.calls.delete.map((d) => d.key).sort()).toEqual(['apps/a1/f1', 'apps/a1/f2']) // both blobs deleted
    expect(registryContainer._get('a1').fileCount).toBe(0) // counters zeroed (full purge)
    expect([...auditContainer._store.values()].find((e) => e.action === 'file:clear').count).toBe(2)
  })

  it('clear-data createdInDraftOnly purges only build-time files (keeps post-approval files)', async () => {
    const { app, filesContainer, store } = harness(
      [approvedApp('a1', { fileCount: 3, fileBytes: 300 })],
      [],
      [fileDoc('d1', 'a1', true), fileDoc('d2', 'a1', true), fileDoc('live', 'a1', false)],
    )
    const token = (await request(app).get('/api/admin/apps/a1/data-summary').set('Authorization', `Bearer ${adminTok()}`)).body.confirmToken
    const res = await request(app).post('/api/admin/apps/a1/clear-data').set('Authorization', `Bearer ${adminTok()}`).send({ confirmToken: token, createdInDraftOnly: true })
    expect(res.body.filesRemoved).toBe(2)
    expect([...filesContainer._store.keys()]).toEqual(['live']) // only the post-approval file remains
    expect(store.calls.delete.map((d) => d.key).sort()).toEqual(['apps/a1/d1', 'apps/a1/d2'])
  })

  it('DELETE purges file blobs BEFORE the registry doc is gone, then removes the doc', async () => {
    const { app, registryContainer, filesContainer, store } = harness(
      [approvedApp('a1', { fileCount: 1, fileBytes: 100 })],
      [],
      [fileDoc('f1', 'a1', false)],
    )
    const res = await request(app).delete('/api/admin/apps/a1').set('Authorization', `Bearer ${adminTok()}`)
    expect(res.body).toEqual({ ok: true })
    expect(registryContainer._get('a1')).toBeUndefined() // registry doc gone
    expect(filesContainer._store.size).toBe(0) // file metadata purged
    expect(store.calls.delete.map((d) => d.key)).toEqual(['apps/a1/f1'])
    expect(store.calls.delete[0].registryPresent).toBe(true) // blob purge PRECEDED the registry delete
  })

  it('recompute-files rebuilds counters from ready metadata, sweeps stale pending, and audits file:gc', async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() // 2h old → past the 1h stale window
    const { app, registryContainer, filesContainer, auditContainer, store } = harness(
      [approvedApp('a1', { fileCount: 9, fileBytes: 9999 })], // drifted counters
      [],
      [
        fileDoc('r1', 'a1', false, { status: 'ready', size: 100 }),
        fileDoc('r2', 'a1', false, { status: 'ready', size: 200 }),
        fileDoc('stuck', 'a1', true, { status: 'pending', size: 50, createdAt: stale }),
      ],
    )
    const res = await request(app).post('/api/admin/apps/a1/recompute-files').set('Authorization', `Bearer ${adminTok()}`)
    expect(res.body).toMatchObject({ appId: 'a1', fileCount: 2, fileBytes: 300, sweptPending: 1 })
    expect(registryContainer._get('a1').fileCount).toBe(2) // drift corrected
    expect(registryContainer._get('a1').fileBytes).toBe(300)
    expect(filesContainer._store.has('stuck')).toBe(false) // stale pending swept
    expect(store.calls.delete.map((d) => d.key)).toEqual(['apps/a1/stuck']) // its (maybe-written) blob best-effort dropped
    expect([...auditContainer._store.values()].find((e) => e.action === 'file:gc').count).toBe(1)
  })

  it('a non-admin cannot reach recompute-files (403)', async () => {
    const { app } = harness([approvedApp('a1')])
    expect((await request(app).post('/api/admin/apps/a1/recompute-files').set('Authorization', `Bearer ${userTok()}`)).status).toBe(403)
  })
})
