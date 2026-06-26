import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAuth } from '../auth/middleware.js'
import { createAttachmentsRouter } from '../attachments.js'
import { createAttachmentsRepo, ATTACHMENT_TOTAL_CAP } from '../attachments-repo.js'
import { makeFakeObjectStore } from './fakeObjectStore.js'
import { makeFakeAttachmentUsageContainer } from './fakeAttachmentUsageCosmos.js'
import { signAccessToken } from '../auth/tokens.js'
import { makePptx, PPTX_TYPE } from './officeFixtures.js'
import { DeckConvertError } from '../deck-convert.js'
import { AnthropicFilesError } from '../anthropic-files.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
  process.env.DECK_ATTACHMENTS_ENABLED = 'true'
  process.env.GOTENBERG_URL = 'http://gotenberg.test'
})
afterAll(() => {
  delete process.env.DECK_ATTACHMENTS_ENABLED
  delete process.env.GOTENBERG_URL
})

const token = (sub = 'alice@bial.test') => signAccessToken({ sub, username: sub, role: 'user' })

function binaryParser(res, cb) {
  const chunks = []
  res.on('data', (c) => chunks.push(Buffer.from(c)))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

function makeApp({ initialUsage = [], anthropicFiles, convertDeck } = {}) {
  const objectStore = makeFakeObjectStore()
  const usage = makeFakeAttachmentUsageContainer(initialUsage)
  const attachmentsRepo = createAttachmentsRepo(objectStore, usage)
  const files = anthropicFiles || { uploadPdf: vi.fn(async () => ({ fileId: 'file_deck_1' })), deleteFile: vi.fn() }
  const convert =
    convertDeck || vi.fn(async () => ({ pdf: Buffer.from('%PDF-1.5\n<< /Type /Page >>\n'), pageCount: 3 }))
  const app = express()
  app.use(express.json({ limit: '6mb' }))
  app.use('/api/attachments', requireAuth, createAttachmentsRouter({ attachmentsRepo, anthropicFiles: files, convertDeck: convert }))
  return { app, objectStore, usage, files, convert, attachmentsRepo }
}

const uploadDeck = async (app, { attachmentId = 'deck-1', name = 'Q3 Review.pptx', sub } = {}) => {
  const pptx = await makePptx({ slides: 3 })
  return {
    res: await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${token(sub)}`)
      .send({ attachmentId, name, mediaType: PPTX_TYPE, base64: pptx.toString('base64') }),
    pptx,
  }
}

describe('POST /api/attachments — deck (.pptx)', () => {
  it('converts, stores the original, uploads the PDF, and returns a deck ref', async () => {
    const { app, files, convert, objectStore } = makeApp()
    const { res, pptx } = await uploadDeck(app)

    expect(res.status).toBe(201)
    expect(res.body.attachment).toMatchObject({
      attachmentId: 'deck-1',
      kind: 'deck',
      mediaType: PPTX_TYPE, // user-facing type stays .pptx
      pdfFileId: 'file_deck_1',
      pageCount: 3,
      truncated: false,
      name: 'Q3 Review.pptx',
    })
    // Converted once; the PDF (not the .pptx) is what was uploaded to the Files API.
    expect(convert).toHaveBeenCalledTimes(1)
    expect(files.uploadPdf).toHaveBeenCalledTimes(1)
    expect(files.uploadPdf.mock.calls[0][0].subarray(0, 4).toString()).toBe('%PDF')
    // The ORIGINAL .pptx is what's stored.
    expect(objectStore._store.get('att/alice@bial.test/deck-1').body.equals(pptx)).toBe(true)
  })

  it('serves the ORIGINAL .pptx on download (never the PDF) — invisible conversion', async () => {
    const { app } = makeApp()
    const { pptx } = await uploadDeck(app)
    const get = await request(app)
      .get('/api/attachments/deck-1')
      .set('Authorization', `Bearer ${token()}`)
      .buffer(true)
      .parse(binaryParser)

    expect(get.status).toBe(200)
    // octet-stream (name-driven .pptx on the client), and NOT application/pdf.
    expect(get.headers['content-type']).toContain('application/octet-stream')
    expect(get.headers['content-type']).not.toContain('pdf')
    expect(Buffer.compare(get.body, pptx)).toBe(0) // byte-identical original .pptx
  })

  it('maps a conversion rejection and stores nothing / uploads nothing (no orphan)', async () => {
    const convertDeck = vi.fn(async () => {
      throw new DeckConvertError('This deck is 500 pages, over the 100-page limit.', {
        status: 413,
        code: 'TOO_MANY_PAGES',
      })
    })
    const { app, files, objectStore } = makeApp({ convertDeck })
    const { res } = await uploadDeck(app)

    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('TOO_MANY_PAGES')
    expect(files.uploadPdf).not.toHaveBeenCalled()
    expect(objectStore._store.size).toBe(0) // nothing stored
  })

  it('maps a bad-structure conversion rejection to 415', async () => {
    const convertDeck = vi.fn(async () => {
      throw new DeckConvertError('Not a valid PowerPoint (.pptx) file.', { status: 415, code: 'UNSUPPORTED_DECK' })
    })
    const { app, files } = makeApp({ convertDeck })
    const { res } = await uploadDeck(app)
    expect(res.status).toBe(415)
    expect(files.uploadPdf).not.toHaveBeenCalled()
  })

  it('rolls back the stored original when the Files API upload fails', async () => {
    const anthropicFiles = {
      uploadPdf: vi.fn(async () => {
        throw new AnthropicFilesError('Could not upload the converted deck.', { status: 502, code: 'FILES_UPLOAD_FAILED' })
      }),
      deleteFile: vi.fn(),
    }
    const { app, objectStore, attachmentsRepo } = makeApp({ anthropicFiles })
    const { res } = await uploadDeck(app)

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('FILES_UPLOAD_FAILED')
    // Rolled back: object removed AND quota decremented (no deck left without a file_id).
    expect(objectStore._store.has('att/alice@bial.test/deck-1')).toBe(false)
    expect(await attachmentsRepo.getTotal('alice@bial.test')).toBe(0)
  })

  it('returns 501 when the feature flag is off', async () => {
    delete process.env.DECK_ATTACHMENTS_ENABLED
    try {
      const { app, files, convert, objectStore } = makeApp()
      const { res } = await uploadDeck(app)
      expect(res.status).toBe(501)
      expect(convert).not.toHaveBeenCalled()
      expect(files.uploadPdf).not.toHaveBeenCalled()
      expect(objectStore._store.size).toBe(0)
    } finally {
      process.env.DECK_ATTACHMENTS_ENABLED = 'true'
    }
  })

  it('maps a per-user storage cap hit to 413 and skips the Files upload', async () => {
    const { app, files } = makeApp({ initialUsage: [{ _id: 'alice@bial.test', total: ATTACHMENT_TOTAL_CAP }] })
    const { res } = await uploadDeck(app)
    expect(res.status).toBe(413)
    expect(files.uploadPdf).not.toHaveBeenCalled()
  })

  it('rejects a .pptx with missing bytes', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${token()}`)
      .send({ attachmentId: 'deck-x', name: 'd.pptx', mediaType: PPTX_TYPE, base64: '' })
    expect(res.status).toBe(400)
  })
})
