import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAuth } from '../auth/middleware.js'
import { createAttachmentsRouter, makeAttachmentLimiter } from '../attachments.js'
import { createAttachmentsRepo, ATTACHMENT_TOTAL_CAP } from '../attachments-repo.js'
import { makeFakeObjectStore } from './fakeObjectStore.js'
import { makeFakeAttachmentUsageContainer } from './fakeAttachmentUsageCosmos.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const token = (sub = 'alice@bial.test') => signAccessToken({ sub, username: sub, role: 'user' })

// Valid magic-byte fixtures.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 11, 22, 33])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 7, 8])
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

/** Force superagent to buffer a binary response body into a Buffer. */
function binaryParser(res, cb) {
  const chunks = []
  res.on('data', (c) => chunks.push(Buffer.from(c)))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

function makeApp({ initialUsage = [], limiter } = {}) {
  const objectStore = makeFakeObjectStore()
  const usage = makeFakeAttachmentUsageContainer(initialUsage)
  const attachmentsRepo = createAttachmentsRepo(objectStore, usage)
  const app = express()
  app.use(express.json({ limit: '6mb' }))
  app.use('/api/attachments', requireAuth, createAttachmentsRouter({ attachmentsRepo }, limiter ? { limiter } : {}))
  return { app, objectStore, usage }
}

const upload = (app, body, sub) => request(app).post('/api/attachments').set('Authorization', `Bearer ${token(sub)}`).send(body)

describe('POST /api/attachments', () => {
  it('stores a valid PNG and GET returns it byte-identical with the right Content-Type', async () => {
    const { app } = makeApp()
    const res = await upload(app, { attachmentId: 'att-1', name: 'd.png', mediaType: 'image/png', base64: PNG.toString('base64') })
    expect(res.status).toBe(201)
    expect(res.body.attachment).toMatchObject({ attachmentId: 'att-1', key: 'att/alice@bial.test/att-1', kind: 'image', mediaType: 'image/png', size: PNG.length })

    const get = await request(app).get('/api/attachments/att-1').set('Authorization', `Bearer ${token()}`).buffer(true).parse(binaryParser)
    expect(get.status).toBe(200)
    expect(get.headers['content-type']).toContain('image/png')
    expect(Buffer.compare(get.body, PNG)).toBe(0) // byte-identical
  })

  it('stores a valid PDF as kind=document', async () => {
    const { app } = makeApp()
    const res = await upload(app, { attachmentId: 'doc-1', name: 'f.pdf', mediaType: 'application/pdf', base64: PDF.toString('base64') })
    expect(res.status).toBe(201)
    expect(res.body.attachment.kind).toBe('document')
  })

  it('rejects a non-allowlisted type, a text type, and a magic-byte mismatch (400)', async () => {
    const { app } = makeApp()
    expect((await upload(app, { attachmentId: 'a', mediaType: 'image/bmp', base64: PNG.toString('base64') })).status).toBe(400)
    expect((await upload(app, { attachmentId: 'a', mediaType: 'text/csv', base64: Buffer.from('a,b,c').toString('base64') })).status).toBe(400)
    // declared png but JPEG bytes → magic mismatch
    expect((await upload(app, { attachmentId: 'a', mediaType: 'image/png', base64: JPEG.toString('base64') })).status).toBe(400)
    // bad id shape
    expect((await upload(app, { attachmentId: '../etc', mediaType: 'image/png', base64: PNG.toString('base64') })).status).toBe(400)
  })

  it('rejects an over-cap upload with 413 and stores nothing', async () => {
    const { app, objectStore } = makeApp({ initialUsage: [{ _id: 'alice@bial.test', total: ATTACHMENT_TOTAL_CAP - 1 }] })
    // A valid PNG that would push total over the cap.
    const big = Buffer.concat([PNG, Buffer.alloc(64)])
    const res = await upload(app, { attachmentId: 'att-1', mediaType: 'image/png', base64: big.toString('base64') })
    expect(res.status).toBe(413)
    expect(objectStore._store.size).toBe(0)
  })

  it('rejects an over-6MB body with 413 (route-specific body cap)', async () => {
    const { app } = makeApp()
    const huge = 'a'.repeat(6.3 * 1024 * 1024)
    const res = await upload(app, { attachmentId: 'att-1', mediaType: 'image/png', base64: huge })
    expect(res.status).toBe(413)
  })
})

describe('GET /api/attachments/:id — per-user scoping', () => {
  it("404s when another user requests an id (key derived from the caller's username)", async () => {
    const { app } = makeApp()
    await upload(app, { attachmentId: 'att-1', mediaType: 'image/png', base64: PNG.toString('base64') }, 'alice@bial.test')
    const bob = await request(app).get('/api/attachments/att-1').set('Authorization', `Bearer ${token('bob@bial.test')}`)
    expect(bob.status).toBe(404)
    const missing = await request(app).get('/api/attachments/nope').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(missing.status).toBe(404)
  })
})

describe('rate limiting', () => {
  it('429s once a user exceeds the per-user upload limit', async () => {
    const { app } = makeApp({ limiter: makeAttachmentLimiter({ windowMs: 60_000, limit: 2 }) })
    const body = { attachmentId: 'att-1', mediaType: 'image/png', base64: PNG.toString('base64') }
    expect((await upload(app, body)).status).toBe(201)
    expect((await upload(app, { ...body, attachmentId: 'att-2' })).status).toBe(201)
    const blocked = await upload(app, { ...body, attachmentId: 'att-3' })
    expect(blocked.status).toBe(429)
  })
})

describe('auth gate', () => {
  it('upload/download/delete are 401 without a Bearer token', async () => {
    const { app } = makeApp()
    expect((await request(app).post('/api/attachments').send({})).status).toBe(401)
    expect((await request(app).get('/api/attachments/x')).status).toBe(401)
    expect((await request(app).delete('/api/attachments/x')).status).toBe(401)
  })
})
