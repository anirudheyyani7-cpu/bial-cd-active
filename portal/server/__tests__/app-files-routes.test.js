import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAppFilesRouter, makeAppFileLimiter, APP_FILE_MAX_JSON } from '../app-files.js'
import { createAppDataRouter, makeDataServiceCors, APP_DATA_BODY_LIMIT } from '../app-data.js'
import { createAppFilesRepo } from '../app-files-repo.js'
import { createDataRecordsRepo } from '../data-records-repo.js'
import { createAppRegistryRepo } from '../app-registry-repo.js'
import { createAuditRepo } from '../audit-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'
import { makeFakeAppFilesContainer } from './fakeAppFilesCosmos.js'
import { makeFakeDataRecordsContainer } from './fakeDataRecordsCosmos.js'
import { makeFakeAuditContainer } from './fakeAuditCosmos.js'
import { makeFakeObjectStore } from './fakeObjectStore.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const SEED = [
  { _id: 'app-open', appKey: 'key-open', status: 'approved', loginRequired: false, fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
  { _id: 'app-login', appKey: 'key-login', status: 'approved', loginRequired: true, fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
  { _id: 'app-draft', appKey: 'key-draft', status: 'draft', loginRequired: false, fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
  { _id: 'app-B', appKey: 'key-B', status: 'approved', loginRequired: false, fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
]

/** A spy ObjectStore wrapping the in-memory fake, counting calls. */
function spyStore(overrides = {}) {
  const base = makeFakeObjectStore()
  const calls = { put: 0, get: 0, delete: 0, getDownloadUrl: 0 }
  const store = {
    calls,
    _base: base,
    async put(...a) { calls.put++; return base.put(...a) },
    async get(...a) { calls.get++; return base.get(...a) },
    async delete(...a) { calls.delete++; return base.delete(...a) },
    async exists(...a) { return base.exists(...a) },
    async getDownloadUrl(...a) { calls.getDownloadUrl++; return base.getDownloadUrl(...a) },
    ...overrides,
  }
  return store
}

function harness({ seed = SEED, limiter, objectStore } = {}) {
  const registryContainer = makeFakeAppRegistryContainer(seed)
  const registryRepo = createAppRegistryRepo(registryContainer)
  const filesContainer = makeFakeAppFilesContainer([])
  const appFilesRepo = createAppFilesRepo(filesContainer, registryRepo)
  const dataContainer = makeFakeDataRecordsContainer([])
  const dataRecordsRepo = createDataRecordsRepo(dataContainer, registryRepo)
  const auditContainer = makeFakeAuditContainer([])
  const auditRepo = createAuditRepo(auditContainer)
  const store = objectStore ?? spyStore()
  const app = express()
  // Mirror the server.js mount order exactly: scoped CORS, then the /files 25 MB
  // parser BEFORE the broad /api/apps 256 KB parser, then the routers.
  app.use('/api/apps', makeDataServiceCors())
  app.use('/api/apps/:appId/files', express.json({ limit: APP_FILE_MAX_JSON }))
  app.use('/api/apps', express.json({ limit: APP_DATA_BODY_LIMIT }))
  app.use('/api/apps/:appId/files', createAppFilesRouter({ appFilesRepo, auditRepo, registryRepo, objectStore: store }, { limiter }))
  app.use('/api/apps/:appId/records', createAppDataRouter({ dataRecordsRepo, auditRepo, registryRepo }))
  return { app, registryContainer, filesContainer, auditContainer, auditRepo, store }
}

const token = (sub = 'alice') => signAccessToken({ sub, username: sub, role: 'user' })
const b64 = (str) => Buffer.from(str).toString('base64')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const filesUrl = (appId, suffix = '') => `/api/apps/${appId}/files${suffix}`
const upOpen = (app, body) => request(app).post(filesUrl('app-open')).set('X-App-Key', 'key-open').send(body)
const pdfBody = (over = {}) => ({ filename: 'report.pdf', contentType: 'application/pdf', base64: b64('%PDF-1.4 hello'), ...over })

describe('app-files routes — upload→list→get→url→content→delete round-trip', () => {
  it('uploads (lands ready), lists, reads, mints a url, proxies content, deletes', async () => {
    const { app, store, registryContainer } = harness()
    const created = await upOpen(app, pdfBody({ collection: 'reports' }))
    expect(created.status).toBe(201)
    expect(created.body.fileId).toBeTypeOf('string')
    expect(created.body.filename).toBe('report.pdf')
    expect(created.body.size).toBeGreaterThan(0)
    expect(created.body.createdInDraft).toBe(false) // approved app
    expect(created.body.createdBy).toBeNull() // open app, anonymous
    const id = created.body.fileId
    expect(store.calls.put).toBe(1)
    expect(registryContainer._get('app-open').fileCount).toBe(1)

    const listed = await request(app).get(filesUrl('app-open', '?collection=reports')).set('X-App-Key', 'key-open')
    expect(listed.status).toBe(200)
    expect(listed.body.files.map((f) => f.fileId)).toEqual([id]) // ready + listable

    const got = await request(app).get(filesUrl('app-open', `/${id}`)).set('X-App-Key', 'key-open')
    expect(got.status).toBe(200)
    expect(got.body.file.filename).toBe('report.pdf')

    const urlRes = await request(app).get(filesUrl('app-open', `/${id}/url`)).set('X-App-Key', 'key-open')
    expect(urlRes.status).toBe(200)
    expect(urlRes.body.url.startsWith('https://')).toBe(true)
    expect(urlRes.body.url).toContain(`apps/app-open/${id}`)
    expect(urlRes.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const content = await request(app).get(filesUrl('app-open', `/${id}/content`)).set('X-App-Key', 'key-open')
    expect(content.status).toBe(200)
    expect(content.headers['x-content-type-options']).toBe('nosniff')

    const del = await request(app).delete(filesUrl('app-open', `/${id}`)).set('X-App-Key', 'key-open')
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })
    expect(registryContainer._get('app-open').fileCount).toBe(0) // quota released
    expect((await request(app).get(filesUrl('app-open', `/${id}`)).set('X-App-Key', 'key-open')).status).toBe(404)
  })

  it('a draft app tags createdInDraft=true; a login app stamps the actor from the token', async () => {
    const { app } = harness()
    const draft = await request(app).post(filesUrl('app-draft')).set('X-App-Key', 'key-draft').send(pdfBody())
    expect(draft.status).toBe(201)
    expect(draft.body.createdInDraft).toBe(true)

    const login = await request(app)
      .post(filesUrl('app-login'))
      .set('X-App-Key', 'key-login')
      .set('Authorization', `Bearer ${token('bob')}`)
      .send(pdfBody())
    expect(login.status).toBe(201)
    expect(login.body.createdBy).toBe('bob')
  })
})

describe('app-files routes — two-store integrity (pending invisible; put-failure compensation)', () => {
  it('a put failure removes the pending row, releases the reserve, and leaves nothing listable', async () => {
    const store = spyStore({ put: async () => { throw new Error('blob store down') } })
    const { app, registryContainer, filesContainer } = harness({ objectStore: store })
    const res = await upOpen(app, pdfBody())
    expect(res.status).toBe(500) // the put threw
    expect(registryContainer._get('app-open').fileBytes).toBe(0) // reserve rolled back — no leak
    expect([...filesContainer._store.values()]).toHaveLength(0) // pending row removed — no orphan metadata
    const listed = await request(app).get(filesUrl('app-open')).set('X-App-Key', 'key-open')
    expect(listed.body.files).toHaveLength(0)
  })
})

describe('app-files routes — tenant isolation', () => {
  it('app-open cannot read/list/delete app-B’s file; /url for a foreign id 404s and never calls the signer', async () => {
    const { app, store } = harness()
    const bFile = await request(app).post(filesUrl('app-B')).set('X-App-Key', 'key-B').send(pdfBody())
    const bId = bFile.body.fileId
    store.calls.getDownloadUrl = 0

    expect((await request(app).get(filesUrl('app-open', `/${bId}`)).set('X-App-Key', 'key-open')).status).toBe(404)
    expect((await request(app).get(filesUrl('app-open')).set('X-App-Key', 'key-open')).body.files).toHaveLength(0)
    expect((await request(app).delete(filesUrl('app-open', `/${bId}`)).set('X-App-Key', 'key-open')).status).toBe(404)

    const urlRes = await request(app).get(filesUrl('app-open', `/${bId}/url`)).set('X-App-Key', 'key-open')
    expect(urlRes.status).toBe(404)
    expect(store.calls.getDownloadUrl).toBe(0) // the SDK signer is never reached for a non-owned file
  })
})

describe('app-files routes — audit (mutations + SAS mint only)', () => {
  it('file:create / file:url / file:delete are audited; list/get/content are not', async () => {
    const { app, auditRepo } = harness()
    const id = (await upOpen(app, pdfBody())).body.fileId
    await request(app).get(filesUrl('app-open')).set('X-App-Key', 'key-open')
    await request(app).get(filesUrl('app-open', `/${id}`)).set('X-App-Key', 'key-open')
    await request(app).get(filesUrl('app-open', `/${id}/content`)).set('X-App-Key', 'key-open')
    expect((await auditRepo.listByApp('app-open')).map((e) => e.action)).toEqual(['file:create']) // reads added nothing

    await request(app).get(filesUrl('app-open', `/${id}/url`)).set('X-App-Key', 'key-open')
    await request(app).delete(filesUrl('app-open', `/${id}`)).set('X-App-Key', 'key-open')
    const actions = (await auditRepo.listByApp('app-open')).map((e) => e.action).sort()
    expect(actions).toEqual(['file:create', 'file:delete', 'file:url'])
  })

  it('an open-app upload records actor null', async () => {
    const { app, auditRepo } = harness()
    await upOpen(app, pdfBody())
    const ev = (await auditRepo.listByApp('app-open')).find((e) => e.action === 'file:create')
    expect(ev.username).toBeNull()
  })
})

describe('app-files routes — body cap + mount order', () => {
  it('a >256 KB upload to /files succeeds while a >256 KB POST to /records 413s', async () => {
    const { app } = harness()
    const bigCsv = b64('x'.repeat(300 * 1024)) // ~400 KB base64 body — over the 256 KB parser
    const up = await request(app)
      .post(filesUrl('app-open'))
      .set('X-App-Key', 'key-open')
      .send({ filename: 'big.csv', contentType: 'text/csv', base64: bigCsv })
    expect(up.status).toBe(201) // parsed by the 25 MB /files carve-out

    const rec = await request(app)
      .post('/api/apps/app-open/records')
      .set('X-App-Key', 'key-open')
      .send({ data: { blob: 'y'.repeat(300 * 1024) } }) // >256 KB JSON
    expect(rec.status).toBe(413) // only the 256 KB parser applies to /records
  })
})

describe('app-files routes — CORS preflight (sandboxed opaque-origin iframe)', () => {
  it('OPTIONS from Origin: null returns ACAO null + X-App-Key allowed', async () => {
    const { app } = harness()
    const res = await request(app)
      .options(filesUrl('app-open'))
      .set('Origin', 'null')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-App-Key')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('null')
    expect(res.headers['access-control-allow-headers']).toMatch(/X-App-Key/i)
  })
})

describe('app-files routes — validation', () => {
  it('rejects disallowed types (incl. svg), bad filename/collection, and magic mismatch', async () => {
    const { app } = harness()
    expect((await upOpen(app, pdfBody({ contentType: 'application/x-evil' }))).status).toBe(400)
    expect((await upOpen(app, pdfBody({ contentType: 'image/svg+xml' }))).status).toBe(400)
    expect((await upOpen(app, pdfBody({ filename: 'bad/name.pdf' }))).status).toBe(400)
    expect((await upOpen(app, pdfBody({ collection: 'bad space' }))).status).toBe(400)
    // declares image/png but the bytes are a PDF → magic mismatch
    expect((await upOpen(app, { filename: 'x.png', contentType: 'image/png', base64: b64('%PDF-1.4') })).status).toBe(400)
    // missing bytes
    expect((await upOpen(app, { filename: 'x.pdf', contentType: 'application/pdf' })).status).toBe(400)
  })

  it('over-quota upload returns 413', async () => {
    // Pin fileBytes above the 500 MB byte cap so the atomic reserve can't match.
    const seed = SEED.map((a) => (a._id === 'app-open' ? { ...a, fileBytes: 600 * 1024 * 1024 } : a))
    const { app } = harness({ seed })
    expect((await upOpen(app, pdfBody())).status).toBe(413)
  })
})

describe('app-files routes — /content hardening', () => {
  it('png is served as its sniffed type inline; csv as octet-stream + attachment; both carry the sandbox CSP', async () => {
    const { app } = harness()
    const png = (await upOpen(app, { filename: 'pic.png', contentType: 'image/png', base64: PNG.toString('base64') })).body.fileId
    const csv = (await upOpen(app, { filename: 'data.csv', contentType: 'text/csv', base64: b64('a,b\n1,2') })).body.fileId

    const pngRes = await request(app).get(filesUrl('app-open', `/${png}/content`)).set('X-App-Key', 'key-open')
    expect(pngRes.headers['content-type']).toMatch(/^image\/png/)
    expect(pngRes.headers['content-disposition']).toMatch(/^inline/)
    expect(pngRes.headers['x-content-type-options']).toBe('nosniff')
    const csp = pngRes.headers['content-security-policy']
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('sandbox')

    const csvRes = await request(app).get(filesUrl('app-open', `/${csv}/content`)).set('X-App-Key', 'key-open')
    expect(csvRes.headers['content-type']).toBe('application/octet-stream')
    expect(csvRes.headers['content-disposition']).toMatch(/^attachment/)
    expect(csvRes.headers['content-security-policy']).toContain('sandbox')
  })
})

describe('app-files routes — download SAS path', () => {
  it('returns {url, expiresAt}; a provider that cannot sign yields 501', async () => {
    const { app } = harness()
    const id = (await upOpen(app, pdfBody())).body.fileId
    const ok = await request(app).get(filesUrl('app-open', `/${id}/url`)).set('X-App-Key', 'key-open')
    expect(ok.status).toBe(200)
    expect(ok.body).toHaveProperty('url')
    expect(ok.body).toHaveProperty('expiresAt')

    const cantSign = spyStore({ getDownloadUrl: async () => { throw new Error('cannot sign') } })
    const h2 = harness({ objectStore: cantSign })
    const id2 = (await upOpen(h2.app, pdfBody())).body.fileId
    const res = await request(h2.app).get(filesUrl('app-open', `/${id2}/url`)).set('X-App-Key', 'key-open')
    expect(res.status).toBe(501)
  })
})

describe('app-files routes — delete ordering + idempotency', () => {
  it('deletes the blob before the metadata (blob delete happens, then the row is gone)', async () => {
    const { app, store, filesContainer } = harness()
    const id = (await upOpen(app, pdfBody())).body.fileId
    const before = store.calls.delete
    await request(app).delete(filesUrl('app-open', `/${id}`)).set('X-App-Key', 'key-open')
    expect(store.calls.delete).toBe(before + 1) // blob deleted
    expect(filesContainer._store.has(id)).toBe(false) // metadata gone
  })

  it('an already-absent blob (NoSuchKey) is idempotent success (row removed, quota released, audited)', async () => {
    const absent = spyStore({ delete: async () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e } })
    const { app, registryContainer, auditRepo } = harness({ objectStore: absent })
    const id = (await upOpen(app, pdfBody({ contentType: 'text/csv', filename: 'a.csv', base64: b64('a,b') }))).body.fileId
    const del = await request(app).delete(filesUrl('app-open', `/${id}`)).set('X-App-Key', 'key-open')
    expect(del.status).toBe(200) // not a 500
    expect(registryContainer._get('app-open').fileCount).toBe(0) // quota released
    expect((await auditRepo.listByApp('app-open')).some((e) => e.action === 'file:delete')).toBe(true)
  })

  it('a genuine blob-store error keeps the metadata row and does NOT release quota', async () => {
    const boom = spyStore({ delete: async () => { throw new Error('storage 500') } })
    const { app, registryContainer, filesContainer, auditRepo } = harness({ objectStore: boom })
    const id = (await upOpen(app, pdfBody({ contentType: 'text/csv', filename: 'a.csv', base64: b64('a,b') }))).body.fileId
    const del = await request(app).delete(filesUrl('app-open', `/${id}`)).set('X-App-Key', 'key-open')
    expect(del.status).toBe(500)
    expect(filesContainer._store.has(id)).toBe(true) // row kept (retryable)
    expect(registryContainer._get('app-open').fileCount).toBe(1) // quota NOT released
    expect((await auditRepo.listByApp('app-open')).some((e) => e.action === 'file:delete')).toBe(false)
  })
})

describe('app-files routes — /content store-error mapping', () => {
  // Seed a ready metadata row directly so /content resolves meta, then read it back
  // through a store whose get() throws the given error.
  const ID = 'cfile-1'
  const seedReady = (h) =>
    h.filesContainer._store.set(ID, {
      _id: ID, appId: 'app-open', collection: 'default', filename: 'report.pdf',
      contentType: 'application/pdf', size: 14, blobKey: `apps/app-open/${ID}`,
      status: 'ready', createdInDraft: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
  const getContent = (h) => request(h.app).get(filesUrl('app-open', `/${ID}/content`)).set('X-App-Key', 'key-open')

  it('a NotFound from store.get → 404 (the blob vanished, not a 500)', async () => {
    const notFound = spyStore({
      get: async () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e },
    })
    const h = harness({ objectStore: notFound })
    seedReady(h)
    expect((await getContent(h)).status).toBe(404)
  })

  it('a generic store error → 500 (NOT swallowed as a 404)', async () => {
    const boom = spyStore({ get: async () => { throw new Error('storage 500') } })
    const h = harness({ objectStore: boom })
    seedReady(h)
    expect((await getContent(h)).status).toBe(500)
  })
})

describe('app-files routes — APP_FILE_MAX_BYTES decoded-size cap', () => {
  it('an upload whose DECODED bytes exceed APP_FILE_MAX_BYTES → 413', async () => {
    const prev = process.env.APP_FILE_MAX_BYTES
    process.env.APP_FILE_MAX_BYTES = '8' // 8 bytes — tiny, so any real file is over
    try {
      vi.resetModules()
      const { createAppFilesRouter: freshRouter, APP_FILE_MAX_JSON: freshJson } = await import('../app-files.js')
      const { createAppFilesRepo: freshFilesRepo } = await import('../app-files-repo.js')
      const { createDataRecordsRepo: freshDataRepo } = await import('../data-records-repo.js')
      const { createAppRegistryRepo: freshRegistryRepo } = await import('../app-registry-repo.js')
      const { createAuditRepo: freshAuditRepo } = await import('../audit-repo.js')

      const registryRepo = freshRegistryRepo(makeFakeAppRegistryContainer(SEED))
      const appFilesRepo = freshFilesRepo(makeFakeAppFilesContainer([]), registryRepo)
      const dataRecordsRepo = freshDataRepo(makeFakeDataRecordsContainer([]), registryRepo)
      const auditRepo = freshAuditRepo(makeFakeAuditContainer([]))
      const store = spyStore()
      const app = express()
      app.use('/api/apps', makeDataServiceCors())
      app.use('/api/apps/:appId/files', express.json({ limit: freshJson }))
      app.use('/api/apps', express.json({ limit: APP_DATA_BODY_LIMIT }))
      app.use('/api/apps/:appId/files', freshRouter({ appFilesRepo, auditRepo, registryRepo, objectStore: store }))

      const res = await request(app)
        .post(filesUrl('app-open'))
        .set('X-App-Key', 'key-open')
        .send(pdfBody()) // '%PDF-1.4 hello' decodes to >8 bytes
      expect(res.status).toBe(413)
      expect(store.calls.put).toBe(0) // rejected at the gateway, never written
    } finally {
      if (prev === undefined) delete process.env.APP_FILE_MAX_BYTES
      else process.env.APP_FILE_MAX_BYTES = prev
      vi.resetModules()
    }
  })
})

describe('app-files routes — login gate + per-app rate limit', () => {
  it('a login app rejects upload/delete without a Bearer token (401)', async () => {
    const { app } = harness()
    expect((await request(app).post(filesUrl('app-login')).set('X-App-Key', 'key-login').send(pdfBody())).status).toBe(401)
    expect((await request(app).delete(filesUrl('app-login', '/whatever')).set('X-App-Key', 'key-login')).status).toBe(401)
  })

  it('the limiter is keyed by appId — one app 429s without affecting another', async () => {
    const { app } = harness({ limiter: makeAppFileLimiter({ limit: 1 }) })
    expect((await request(app).get(filesUrl('app-open')).set('X-App-Key', 'key-open')).status).toBe(200)
    expect((await request(app).get(filesUrl('app-open')).set('X-App-Key', 'key-open')).status).toBe(429)
    expect((await request(app).get(filesUrl('app-B')).set('X-App-Key', 'key-B')).status).toBe(200) // separate bucket
  })
})
