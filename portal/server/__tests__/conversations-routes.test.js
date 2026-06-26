import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { PPTX_TYPE } from './officeFixtures.js'
import { requireAuth } from '../auth/middleware.js'
import { createConversationsRouter } from '../conversations.js'
import { createConversationsRepo } from '../conversations-repo.js'
import { createMessagesRepo } from '../messages-repo.js'
import { createAttachmentsRepo } from '../attachments-repo.js'
import { makeFakeConversationsContainer } from './fakeConversationsCosmos.js'
import { makeFakeMessagesContainer } from './fakeMessagesCosmos.js'
import { makeFakeObjectStore } from './fakeObjectStore.js'
import { makeFakeAttachmentUsageContainer } from './fakeAttachmentUsageCosmos.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const token = (sub = 'alice@bial.test') => signAccessToken({ sub, username: sub, role: 'user' })

function makeApp({ anthropicFiles } = {}) {
  const convContainer = makeFakeConversationsContainer([])
  const msgContainer = makeFakeMessagesContainer([])
  const objectStore = makeFakeObjectStore()
  const usage = makeFakeAttachmentUsageContainer([])
  const conversationsRepo = createConversationsRepo(convContainer)
  const messagesRepo = createMessagesRepo(msgContainer)
  const attachmentsRepo = createAttachmentsRepo(objectStore, usage)
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use(
    '/api/conversations',
    requireAuth,
    createConversationsRouter({ conversationsRepo, messagesRepo, attachmentsRepo, ...(anthropicFiles ? { anthropicFiles } : {}) }),
  )
  return { app, convContainer, msgContainer, objectStore, usage, attachmentsRepo }
}

const textMsg = (id, seq, text) => ({ _id: id, role: seq % 2 === 0 ? 'user' : 'assistant', seq, parts: [{ type: 'text', text }] })
const post = (app, id, body, sub) =>
  request(app).post(`/api/conversations/${id}/messages`).set('Authorization', `Bearer ${token(sub)}`).send(body)

describe('POST /api/conversations/:id/messages', () => {
  it('persists with the TOKEN username (ignoring the body) and reads back in seq order with parts intact', async () => {
    const { app } = makeApp()
    await post(app, 'conv-1', { message: { ...textMsg('m0', 0, 'hello'), username: 'attacker@evil.test' }, header: { kind: 'planning', title: 'Greeting', username: 'attacker@evil.test' } }, 'alice@bial.test')
    await post(app, 'conv-1', { message: textMsg('m1', 1, 'hi back'), header: { kind: 'planning' } }, 'alice@bial.test')

    const res = await request(app).get('/api/conversations/conv-1').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(res.status).toBe(200)
    expect(res.body.conversation.username).toBe('alice@bial.test') // token, not body
    expect(res.body.conversation.title).toBe('Greeting')
    expect(res.body.messages.map((m) => m._id)).toEqual(['m0', 'm1']) // seq order
    expect(res.body.messages[0].parts).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('round-trips a file-ref part intact', async () => {
    const { app } = makeApp()
    const filePart = { type: 'file', attachmentId: 'att-1', key: 'att/alice@bial.test/att-1', kind: 'image', mediaType: 'image/png', name: 'd.png', size: 99 }
    await post(app, 'conv-1', { message: { _id: 'm0', role: 'user', seq: 0, parts: [filePart, { type: 'text', text: 'see this' }] }, header: { kind: 'planning' } }, 'alice@bial.test')
    const res = await request(app).get('/api/conversations/conv-1').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(res.body.messages[0].parts[0]).toEqual(filePart)
  })

  it('round-trips an office file-ref part (kind=office carries extracted text)', async () => {
    const { app } = makeApp()
    const officePart = { type: 'file', kind: 'office', format: 'word', attachmentId: 'att-w', key: 'att/alice@bial.test/att-w', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'plan.docx', size: 99, text: '# Plan\n\nbody', truncated: false }
    const res = await post(app, 'conv-o', { message: { _id: 'm0', role: 'user', seq: 0, parts: [officePart, { type: 'text', text: 'review this' }] }, header: { kind: 'planning' } }, 'alice@bial.test')
    expect(res.status).toBe(201)
    const get = await request(app).get('/api/conversations/conv-o').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(get.body.messages[0].parts[0]).toEqual(officePart)
  })

  it('rejects an office part with missing or oversized extracted text (400)', async () => {
    const { app } = makeApp()
    const base = { type: 'file', kind: 'office', format: 'excel', attachmentId: 'att-x', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'q.xlsx', size: 5 }
    const noText = await post(app, 'c', { message: { _id: 'm', role: 'user', seq: 0, parts: [base] }, header: { kind: 'planning' } }, 'alice@bial.test')
    expect(noText.status).toBe(400)
    const huge = await post(app, 'c', { message: { _id: 'm', role: 'user', seq: 0, parts: [{ ...base, text: 'x'.repeat(512 * 1024 + 1) }] }, header: { kind: 'planning' } }, 'alice@bial.test')
    expect(huge.status).toBe(400)
  })

  it('a POST to an _id owned by another user does not overwrite it (write-IDOR → 409)', async () => {
    const { app, convContainer } = makeApp()
    await post(app, 'shared', { message: textMsg('m0', 0, 'alice'), header: { kind: 'planning', title: 'alice owns' } }, 'alice@bial.test')
    const res = await post(app, 'shared', { message: textMsg('m1', 1, 'bob'), header: { kind: 'planning', title: 'bob hijack' } }, 'bob@bial.test')
    expect(res.status).toBe(409)
    expect(convContainer._get('shared').username).toBe('alice@bial.test')
    expect(convContainer._get('shared').title).toBe('alice owns')
  })

  it('rejects a malformed message (bad role / non-array parts) with 400', async () => {
    const { app } = makeApp()
    expect((await post(app, 'c', { message: { _id: 'm', role: 'system', seq: 0, parts: [{ type: 'text', text: 'x' }] }, header: { kind: 'planning' } }, 'alice@bial.test')).status).toBe(400)
    expect((await post(app, 'c', { message: { _id: 'm', role: 'user', seq: 0, parts: 'nope' }, header: { kind: 'planning' } }, 'alice@bial.test')).status).toBe(400)
    expect((await post(app, 'c', { message: textMsg('m', 0, 'x'), header: { kind: 'bogus' } }, 'alice@bial.test')).status).toBe(400)
  })
})

describe('GET /api/conversations', () => {
  it('lists only the caller headers, filtered by kind', async () => {
    const { app } = makeApp()
    await post(app, 'p1', { message: textMsg('m', 0, 'x'), header: { kind: 'planning' } }, 'alice@bial.test')
    await post(app, 'b1', { message: textMsg('m', 0, 'y'), header: { kind: 'builder' } }, 'alice@bial.test')
    await post(app, 'p2', { message: textMsg('m', 0, 'z'), header: { kind: 'planning' } }, 'bob@bial.test')

    const planning = await request(app).get('/api/conversations?kind=planning').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(planning.body.conversations.map((c) => c._id)).toEqual(['p1']) // alice planning only
    const all = await request(app).get('/api/conversations').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(all.body.conversations.map((c) => c._id).sort()).toEqual(['b1', 'p1'])
  })

  it("returns 404 for another user's conversation (cross-device isolation)", async () => {
    const { app } = makeApp()
    await post(app, 'conv-1', { message: textMsg('m', 0, 'secret'), header: { kind: 'planning' } }, 'alice@bial.test')
    // A fresh client as ALICE sees it (cross-device); BOB never does.
    expect((await request(app).get('/api/conversations/conv-1').set('Authorization', `Bearer ${token('alice@bial.test')}`)).status).toBe(200)
    expect((await request(app).get('/api/conversations/conv-1').set('Authorization', `Bearer ${token('bob@bial.test')}`)).status).toBe(404)
  })
})

describe('PATCH /api/conversations/:id', () => {
  it('updates code.current with a well-formed snapshot; rejects a malformed code with 400', async () => {
    const { app, convContainer } = makeApp()
    await post(app, 'b1', { message: textMsg('m', 0, 'build'), header: { kind: 'builder' } }, 'alice@bial.test')
    const good = await request(app)
      .patch('/api/conversations/b1')
      .set('Authorization', `Bearer ${token('alice@bial.test')}`)
      .send({ code: { source: 'function PreviewApp(){}', entry: 'PreviewApp', model: 'opus', createdAt: '2026-06-22T00:00:00Z' } })
    expect(good.status).toBe(200)
    expect(convContainer._get('b1').code.current.source).toBe('function PreviewApp(){}')

    const bad = await request(app).patch('/api/conversations/b1').set('Authorization', `Bearer ${token('alice@bial.test')}`).send({ code: { entry: 'PreviewApp' } })
    expect(bad.status).toBe(400)
  })

  it("404s a PATCH to another user's conversation", async () => {
    const { app } = makeApp()
    await post(app, 'b1', { message: textMsg('m', 0, 'build'), header: { kind: 'builder' } }, 'alice@bial.test')
    const res = await request(app).patch('/api/conversations/b1').set('Authorization', `Bearer ${token('bob@bial.test')}`).send({ title: 'x' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/conversations/:id', () => {
  it('removes header + messages + the conversation attachment objects; another conversation untouched', async () => {
    const { app, attachmentsRepo, objectStore, convContainer, msgContainer } = makeApp()
    // Pre-store the object the file part will reference.
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    await attachmentsRepo.putBytes({ attachmentId: 'att-1', username: 'alice@bial.test', mediaType: 'image/png', size: buffer.length, name: 'd.png', buffer })
    const filePart = { type: 'file', attachmentId: 'att-1', key: 'att/alice@bial.test/att-1', kind: 'image', mediaType: 'image/png', name: 'd.png', size: buffer.length }

    await post(app, 'conv-1', { message: { _id: 'm0', role: 'user', seq: 0, parts: [filePart, { type: 'text', text: 'pic' }] }, header: { kind: 'planning' } }, 'alice@bial.test')
    await post(app, 'conv-2', { message: textMsg('m0', 0, 'keep me'), header: { kind: 'planning' } }, 'alice@bial.test')

    const del = await request(app).delete('/api/conversations/conv-1').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(del.status).toBe(200)
    expect(convContainer._get('conv-1')).toBeUndefined()
    expect([...msgContainer._store.values()].some((m) => m.conversationId === 'conv-1')).toBe(false)
    expect(objectStore._store.has('att/alice@bial.test/att-1')).toBe(false) // bytes swept
    expect(convContainer._get('conv-2')).toBeDefined() // untouched
  })

  it("404s a DELETE of another user's conversation, leaving it intact", async () => {
    const { app, convContainer } = makeApp()
    await post(app, 'conv-1', { message: textMsg('m', 0, 'x'), header: { kind: 'planning' } }, 'alice@bial.test')
    expect((await request(app).delete('/api/conversations/conv-1').set('Authorization', `Bearer ${token('bob@bial.test')}`)).status).toBe(404)
    expect(convContainer._get('conv-1')).toBeDefined()
  })
})

describe('auth gate', () => {
  it('every route is 401 without a Bearer token', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/conversations')).status).toBe(401)
    expect((await request(app).get('/api/conversations/x')).status).toBe(401)
    expect((await request(app).post('/api/conversations/x/messages').send({})).status).toBe(401)
    expect((await request(app).patch('/api/conversations/x').send({})).status).toBe(401)
    expect((await request(app).delete('/api/conversations/x')).status).toBe(401)
  })
})

describe('DELETE /api/conversations/:id — deck Files-API cleanup', () => {
  const deckPart = (id, fileId) => ({
    type: 'file',
    kind: 'deck',
    attachmentId: id,
    key: `att/alice@bial.test/${id}`,
    mediaType: PPTX_TYPE,
    name: `${id}.pptx`,
    size: 100,
    pdfFileId: fileId,
    pageCount: 3,
  })
  const deckMsg = (id, seq, fileId) => ({ _id: id, role: 'user', seq, parts: [deckPart(`d-${id}`, fileId)] })

  it('releases the Files-API PDF for each deck part on delete', async () => {
    const deleteFile = vi.fn(async () => {})
    const { app } = makeApp({ anthropicFiles: { uploadPdf: vi.fn(), deleteFile } })
    await post(app, 'conv-d', { message: deckMsg('m0', 0, 'file_a'), header: { kind: 'planning' } }, 'alice@bial.test')
    await post(app, 'conv-d', { message: deckMsg('m1', 2, 'file_b'), header: { kind: 'planning' } }, 'alice@bial.test')

    const del = await request(app).delete('/api/conversations/conv-d').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(del.status).toBe(200)
    expect(deleteFile).toHaveBeenCalledTimes(2)
    expect(deleteFile.mock.calls.map((c) => c[0]).sort()).toEqual(['file_a', 'file_b'])
  })

  it('de-dupes a repeated pdfFileId across turns (sticky deck)', async () => {
    const deleteFile = vi.fn(async () => {})
    const { app } = makeApp({ anthropicFiles: { uploadPdf: vi.fn(), deleteFile } })
    await post(app, 'conv-d', { message: deckMsg('m0', 0, 'file_same'), header: { kind: 'planning' } }, 'alice@bial.test')
    await post(app, 'conv-d', { message: deckMsg('m1', 2, 'file_same'), header: { kind: 'planning' } }, 'alice@bial.test')
    await request(app).delete('/api/conversations/conv-d').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(deleteFile).toHaveBeenCalledWith('file_same')
  })

  it('does not fail the delete when deleteFile throws (best-effort)', async () => {
    const deleteFile = vi.fn(async () => {
      throw new Error('already gone')
    })
    const { app, convContainer } = makeApp({ anthropicFiles: { uploadPdf: vi.fn(), deleteFile } })
    await post(app, 'conv-d', { message: deckMsg('m0', 0, 'file_a'), header: { kind: 'planning' } }, 'alice@bial.test')
    const del = await request(app).delete('/api/conversations/conv-d').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(del.status).toBe(200)
    expect(convContainer._get('conv-d')).toBeUndefined() // delete still completed
  })

  it('makes no Files-API calls when there are no deck parts', async () => {
    const deleteFile = vi.fn(async () => {})
    const { app } = makeApp({ anthropicFiles: { uploadPdf: vi.fn(), deleteFile } })
    await post(app, 'conv-t', { message: textMsg('m0', 0, 'just text'), header: { kind: 'planning' } }, 'alice@bial.test')
    await request(app).delete('/api/conversations/conv-t').set('Authorization', `Bearer ${token('alice@bial.test')}`)
    expect(deleteFile).not.toHaveBeenCalled()
  })
})
