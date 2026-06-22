import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../../server.js'
import { createUsersRepo } from '../users-repo.js'
import { createUsageRepo } from '../usage-repo.js'
import { createFeedbackRepo } from '../feedback-repo.js'
import { createConversationsRepo } from '../conversations-repo.js'
import { createMessagesRepo } from '../messages-repo.js'
import { createAttachmentsRepo } from '../attachments-repo.js'
import { signAccessToken } from '../auth/tokens.js'
import { hashPassword } from '../auth/password.js'
import { makeFakeContainer } from './fakeCosmos.js'
import { makeFakeUsageContainer } from './fakeUsageCosmos.js'
import { makeFakeFeedbackContainer } from './fakeFeedbackCosmos.js'
import { makeFakeConversationsContainer } from './fakeConversationsCosmos.js'
import { makeFakeMessagesContainer } from './fakeMessagesCosmos.js'
import { makeFakeAttachmentUsageContainer } from './fakeAttachmentUsageCosmos.js'
import { makeFakeObjectStore } from './fakeObjectStore.js'

/** A fresh in-memory feedback repo for the createApp DI seam. */
const fakeFeedbackRepo = () => createFeedbackRepo(makeFakeFeedbackContainer([]))

/** Fresh in-memory persistence repos for the createApp DI seam (chats/images/code). */
const fakePersistence = () => ({
  conversationsRepo: createConversationsRepo(makeFakeConversationsContainer([])),
  messagesRepo: createMessagesRepo(makeFakeMessagesContainer([])),
  attachmentsRepo: createAttachmentsRepo(makeFakeObjectStore(), makeFakeAttachmentUsageContainer([])),
})

const SPA_HTML = '<!doctype html><title>BIAL</title><div id="root"></div>'
let distDir

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
  process.env.ANTHROPIC_FOUNDRY_API_KEY = 'test-key'
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bial-dist-'))
  fs.writeFileSync(path.join(distDir, 'index.html'), SPA_HTML)
})

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true })
})

let claudeStream

const DEFAULT_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/**
 * A stand-in for the Foundry `MessageStream`: both async-iterable (yields the
 * text deltas) AND exposes finalMessage() (resolving to a known usage, or
 * rejecting to model an upstream stream error). The post-stream capture runs on
 * the happy path, so the stub MUST expose finalMessage() — a bare async
 * generator (no finalMessage) would skip capture and hide regressions.
 */
function makeStreamStub({ deltas = ['Hello', ' world'], usage = DEFAULT_USAGE, finalRejects = false } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of deltas) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }
      }
    },
    async finalMessage() {
      if (finalRejects) throw new Error('upstream stream error')
      return { usage }
    },
  }
}

function makeClaudeClient(streamOpts) {
  claudeStream = vi.fn(async () => makeStreamStub(streamOpts))
  return { messages: { stream: claudeStream } }
}

function makeServer({ usageRepo, streamOpts, dailyTokenLimit } = {}) {
  const container = makeFakeContainer([])
  const repo = createUsersRepo(container)
  const resolvedUsageRepo = usageRepo ?? createUsageRepo(makeFakeUsageContainer([]))
  return createApp({ repo, usageRepo: resolvedUsageRepo, feedbackRepo: fakeFeedbackRepo(), ...fakePersistence(), claudeClient: makeClaudeClient(streamOpts), distDir, dailyTokenLimit })
}

const validToken = () => signAccessToken({ sub: 'alice', username: 'alice', role: 'user' })

describe('server integration', () => {
  let app
  beforeEach(() => {
    app = makeServer()
  })

  it('AE3: POST /api/claude with no token → 401 and no upstream Claude call', async () => {
    const res = await request(app).post('/api/claude').send({ messages: [] })
    expect(res.status).toBe(401)
    expect(claudeStream).not.toHaveBeenCalled()
  })

  it('POST /api/claude with an invalid token → 401, no upstream call', async () => {
    const res = await request(app)
      .post('/api/claude')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .send({ messages: [] })
    expect(res.status).toBe(401)
    expect(claudeStream).not.toHaveBeenCalled()
  })

  it('the SSE-route 401 is JSON (headers not switched to event-stream)', async () => {
    const res = await request(app).post('/api/claude').send({ messages: [] })
    expect(res.status).toBe(401)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body?.error?.message).toBeTypeOf('string')
  })

  it('POST /api/claude with a valid token reaches the proxy and streams', async () => {
    const res = await request(app)
      .post('/api/claude')
      .set('Authorization', `Bearer ${validToken()}`)
      .send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(claudeStream).toHaveBeenCalledOnce()
    expect(res.text).toContain('Hello')
    expect(res.text).toContain('[DONE]')
  })

  it('unknown non-/api GET returns the SPA index.html', async () => {
    const res = await request(app).get('/workspace/builder')
    expect(res.status).toBe(200)
    expect(res.text).toContain('id="root"')
  })

  it('unknown /api GET is not shadowed by the SPA fallback (404)', async () => {
    const res = await request(app).get('/api/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('every response carries a Content-Security-Policy header', async () => {
    const res = await request(app).get('/workspace')
    expect(res.headers['content-security-policy']).toBeTypeOf('string')
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
  })

  it('CSP carries the hardening directives and X-Frame-Options is set', async () => {
    const res = await request(app).get('/workspace')
    const csp = res.headers['content-security-policy']
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(res.headers['x-frame-options']).toBeTypeOf('string')
  })

  it('end-to-end: login → call /api/claude with the token → logout clears the session', async () => {
    const container = makeFakeContainer([
      {
        _id: 'alice',
        username: 'alice',
        email: 'alice@bial.test',
        name: 'Alice',
        role: 'user',
        passwordHash: await hashPassword('pw-correct'),
        refreshTokenHash: null,
        refreshTokenExpiresAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    const e2eApp = createApp({
      repo: createUsersRepo(container),
      usageRepo: createUsageRepo(makeFakeUsageContainer([])),
      feedbackRepo: fakeFeedbackRepo(),
      ...fakePersistence(),
      claudeClient: makeClaudeClient(),
      distDir,
    })

    const login = await request(e2eApp).post('/api/auth/login').send({ username: 'alice', password: 'pw-correct' })
    expect(login.status).toBe(200)
    const token = login.body.accessToken

    const claude = await request(e2eApp)
      .post('/api/claude')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(claude.status).toBe(200)
    expect(claude.text).toContain('Hello')

    const logout = await request(e2eApp).post('/api/auth/logout').set('Authorization', `Bearer ${token}`)
    expect(logout.status).toBe(200)
    expect(container._get('alice').refreshTokenHash).toBeNull()

    // externally observable: the issued refresh token no longer works after logout
    const afterLogout = await request(e2eApp)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
    expect(afterLogout.status).toBe(401)
  })

  it('CORS allows the Vite dev origin and not the removed :3000 origin', async () => {
    const allowed = await request(app)
      .post('/api/claude')
      .set('Origin', 'http://localhost:5173')
      .send({ messages: [] })
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173')

    const rejected = await request(app)
      .post('/api/claude')
      .set('Origin', 'http://localhost:3000')
      .send({ messages: [] })
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('createApp dependency guards', () => {
  it('throws when usageRepo is omitted (enforcement must never silently no-op)', () => {
    const repo = createUsersRepo(makeFakeContainer([]))
    expect(() => createApp({ repo, claudeClient: makeClaudeClient(), distDir })).toThrow(/usageRepo is required/)
  })

  it('throws when feedbackRepo is omitted (submit + admin read must never silently no-op)', () => {
    const repo = createUsersRepo(makeFakeContainer([]))
    const usageRepo = createUsageRepo(makeFakeUsageContainer([]))
    expect(() => createApp({ repo, usageRepo, claudeClient: makeClaudeClient(), distDir })).toThrow(
      /feedbackRepo is required/,
    )
  })

  it('throws when a persistence repo is omitted (chats/images/code routes must not silently 404)', () => {
    const repo = createUsersRepo(makeFakeContainer([]))
    const usageRepo = createUsageRepo(makeFakeUsageContainer([]))
    const feedbackRepo = fakeFeedbackRepo()
    expect(() => createApp({ repo, usageRepo, feedbackRepo, claudeClient: makeClaudeClient(), distDir })).toThrow(
      /conversationsRepo is required/,
    )
  })
})

describe('POST /api/feedback wired through createApp', () => {
  it('persists an authed submission (author from the token) and 401s without a token', async () => {
    const feedbackContainer = makeFakeFeedbackContainer([])
    const app2 = createApp({
      repo: createUsersRepo(makeFakeContainer([])),
      usageRepo: createUsageRepo(makeFakeUsageContainer([])),
      feedbackRepo: createFeedbackRepo(feedbackContainer),
      ...fakePersistence(),
      claudeClient: makeClaudeClient(),
      distDir,
    })

    const ok = await request(app2)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${validToken()}`)
      .send({ message: 'wired e2e', page: '/chat' })
    expect(ok.status).toBe(201)
    const stored = [...feedbackContainer._store.values()]
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ username: 'alice', message: 'wired e2e', page: '/chat' })

    const noTok = await request(app2).post('/api/feedback').send({ message: 'x' })
    expect(noTok.status).toBe(401)
  })
})

describe('daily token limit enforcement', () => {
  const auth = (req) => req.set('Authorization', `Bearer ${validToken()}`)

  it('AE1: a user at/over the limit gets 429 before any SSE call (no upstream stream)', async () => {
    // Seed usage at the limit via a spy repo so we can assert the stream was never created.
    const usageRepo = {
      getUsage: vi.fn(async () => ({ inputTokens: 700, outputTokens: 300 })), // 1000 used
      addUsage: vi.fn(async () => {}),
    }
    const app2 = makeServer({ usageRepo, dailyTokenLimit: 1000 })
    const res = await auth(request(app2).post('/api/claude')).send({ messages: [{ role: 'user', content: 'hi' }] })

    expect(res.status).toBe(429)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body.error.code).toBe('daily_token_limit_exceeded')
    expect(res.body.error.limit).toBe(1000)
    expect(res.body.error.used).toBe(1000)
    expect(res.body.error.remaining).toBe(0)
    expect(claudeStream).not.toHaveBeenCalled() // gate ran BEFORE the upstream call
  })

  it('under the limit streams normally (happy path with the upgraded MessageStream stub)', async () => {
    const app2 = makeServer({ dailyTokenLimit: 1000 })
    const res = await auth(request(app2).post('/api/claude')).send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.text).toContain('Hello')
    expect(res.text).toContain('[DONE]')
    expect(claudeStream).toHaveBeenCalledOnce()
  })

  it('records usage once after streaming, summing input + cache_creation + cache_read', async () => {
    let resolveAdd
    const added = new Promise((r) => {
      resolveAdd = r
    })
    const usageRepo = {
      getUsage: vi.fn(async () => null), // under limit
      addUsage: vi.fn(async (...args) => resolveAdd(args)),
    }
    const app2 = makeServer({
      usageRepo,
      streamOpts: {
        usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 7, cache_read_input_tokens: 3 },
      },
    })
    await auth(request(app2).post('/api/claude')).send({ messages: [{ role: 'user', content: 'hi' }] })

    const [username, , input, output] = await added // wait for the post-end capture
    expect(usageRepo.addUsage).toHaveBeenCalledOnce()
    expect(username).toBe('alice')
    expect(input).toBe(110) // 100 + 7 + 3
    expect(output).toBe(40)
  })

  it('treats null cache fields as 0 when summing billed input', async () => {
    let resolveAdd
    const added = new Promise((r) => {
      resolveAdd = r
    })
    const usageRepo = {
      getUsage: vi.fn(async () => null),
      addUsage: vi.fn(async (...args) => resolveAdd(args)),
    }
    const app2 = makeServer({
      usageRepo,
      streamOpts: {
        usage: { input_tokens: 50, output_tokens: 9, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      },
    })
    await auth(request(app2).post('/api/claude')).send({ messages: [{ role: 'user', content: 'hi' }] })

    const [, , input, output] = await added
    expect(input).toBe(50)
    expect(output).toBe(9)
  })

  it('upstream stream error (finalMessage rejects) → response already ended, no 500, addUsage not called', async () => {
    const usageRepo = {
      getUsage: vi.fn(async () => null),
      addUsage: vi.fn(async () => {}),
    }
    const app2 = makeServer({ usageRepo, streamOpts: { finalRejects: true } })
    const res = await auth(request(app2).post('/api/claude')).send({ messages: [{ role: 'user', content: 'hi' }] })

    expect(res.status).toBe(200) // stream wrote deltas + [DONE] before finalMessage rejected
    await new Promise((r) => setTimeout(r, 20)) // let the post-end capture attempt + reject
    expect(usageRepo.addUsage).not.toHaveBeenCalled()
  })

  it('GET /api/usage/today returns { used, limit, remaining, resetsAt }; remaining floors at 0', async () => {
    const usageRepo = {
      getUsage: vi.fn(async () => ({ inputTokens: 1200, outputTokens: 0 })), // over a small limit
      addUsage: vi.fn(async () => {}),
    }
    const app2 = makeServer({ usageRepo, dailyTokenLimit: 1000 })
    const res = await auth(request(app2).get('/api/usage/today'))
    expect(res.status).toBe(200)
    expect(res.body.used).toBe(1200)
    expect(res.body.limit).toBe(1000)
    expect(res.body.remaining).toBe(0) // floored
    expect(res.body.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('GET /api/usage/today without a token → 401', async () => {
    const res = await request(makeServer()).get('/api/usage/today')
    expect(res.status).toBe(401)
  })

  it('clamps a client-supplied max_tokens to the server ceiling (16000)', async () => {
    const app2 = makeServer()
    await auth(request(app2).post('/api/claude')).send({ max_tokens: 999999, messages: [{ role: 'user', content: 'hi' }] })
    expect(claudeStream).toHaveBeenCalledOnce()
    expect(claudeStream.mock.calls[0][0].max_tokens).toBe(16000) // not the requested 999999
  })
})

describe('per-user daily limit', () => {
  // 'rich' has a high override; 'alice' (absent from the store) resolves to the
  // injected standard-plan default of 1000.
  const RICH = {
    _id: 'rich',
    username: 'rich',
    name: 'Rich',
    role: 'user',
    passwordHash: '$argon2id$v=19$x',
    refreshTokenHash: null,
    refreshTokenExpiresAt: null,
    limits: { dailyTokenLimit: 5000 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const tok = (username) => signAccessToken({ sub: username, username, role: 'user' })

  // One usageRepo reports the same `used` for every user, so the only thing that
  // differs between alice and rich is their resolved per-user limit.
  function appWithUsed(used) {
    const repo = createUsersRepo(makeFakeContainer([RICH]))
    const usageRepo = {
      getUsage: vi.fn(async () => ({ inputTokens: used, outputTokens: 0 })),
      addUsage: vi.fn(async () => {}),
    }
    return createApp({ repo, usageRepo, feedbackRepo: fakeFeedbackRepo(), ...fakePersistence(), claudeClient: makeClaudeClient(), distDir, dailyTokenLimit: 1000 })
  }

  it('blocks a default user where an override user passes (used=1500)', async () => {
    const app2 = appWithUsed(1500)

    const blocked = await request(app2)
      .post('/api/claude')
      .set('Authorization', `Bearer ${tok('alice')}`)
      .send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.limit).toBe(1000) // standard plan
    expect(blocked.body.error.message).toMatch(/contact your administrator/i)

    const ok = await request(app2)
      .post('/api/claude')
      .set('Authorization', `Bearer ${tok('rich')}`)
      .send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(ok.status).toBe(200) // 1500 used < 5000 override
  })

  it('GET /api/usage/today reflects the per-user limit', async () => {
    const app2 = appWithUsed(100)
    const res = await request(app2).get('/api/usage/today').set('Authorization', `Bearer ${tok('rich')}`)
    expect(res.status).toBe(200)
    expect(res.body.limit).toBe(5000)
    expect(res.body.remaining).toBe(4900)
  })
})

describe('attachment validation + body size', () => {
  const auth = (req) => req.set('Authorization', `Bearer ${validToken()}`)
  // 1x1 transparent PNG (valid magic bytes \x89PNG).
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  // Minimal PDF header bytes (%PDF-1.4) base64-encoded.
  const PDF_B64 = Buffer.from('%PDF-1.4\n', 'utf8').toString('base64')

  const imageMsg = (mediaType, data) => ({
    role: 'user',
    content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }, { type: 'text', text: 'hi' }],
  })

  it('rejects a media_type outside the allowlist with 400 (no upstream call)', async () => {
    const res = await auth(request(makeServer()).post('/api/claude')).send({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: PNG_B64 } }],
        },
      ],
    })
    expect(res.status).toBe(400)
    expect(claudeStream).not.toHaveBeenCalled()
  })

  it('rejects bytes that do not match the declared type (magic-byte mismatch) with 400', async () => {
    // Claim PDF but send PNG bytes.
    const res = await auth(request(makeServer()).post('/api/claude')).send({
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PNG_B64 } }],
        },
      ],
    })
    expect(res.status).toBe(400)
    expect(claudeStream).not.toHaveBeenCalled()
  })

  it('rejects a cross-type block (document declared with an image media_type) with 400', async () => {
    // A document block must be application/pdf. image/png in a document block
    // passes the allowlist + magic check but 400s upstream — reject it cleanly.
    const res = await auth(request(makeServer()).post('/api/claude')).send({
      messages: [
        { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }] },
      ],
    })
    expect(res.status).toBe(400)
    expect(claudeStream).not.toHaveBeenCalled()
  })

  it('accepts a valid PNG image block and streams', async () => {
    const res = await auth(request(makeServer()).post('/api/claude')).send({ messages: [imageMsg('image/png', PNG_B64)] })
    expect(res.status).toBe(200)
    expect(claudeStream).toHaveBeenCalledOnce()
  })

  it('accepts a valid PDF document block and streams', async () => {
    const res = await auth(request(makeServer()).post('/api/claude')).send({
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 } }],
        },
      ],
    })
    expect(res.status).toBe(200)
    expect(claudeStream).toHaveBeenCalledOnce()
  })

  it('accepts valid JPEG, GIF and WebP magic bytes', async () => {
    const cases = [
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')],
      ['image/gif', Buffer.from('GIF89a').toString('base64')],
      ['image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]).toString('base64')],
    ]
    for (const [mediaType, data] of cases) {
      const res = await auth(request(makeServer()).post('/api/claude')).send({ messages: [imageMsg(mediaType, data)] })
      expect(res.status, mediaType).toBe(200)
    }
  })

  it('rejects a non-WebP RIFF container declared as image/webp (WAV/AVI share the RIFF prefix)', async () => {
    // RIFF alone also matches WAV/AVI; the validator additionally requires the
    // "WEBP" form-type at offset 8, so a WAV declared as image/webp is rejected.
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE')]).toString('base64')
    const res = await auth(request(makeServer()).post('/api/claude')).send({ messages: [imageMsg('image/webp', wav)] })
    expect(res.status).toBe(400)
    expect(claudeStream).not.toHaveBeenCalled()
  })

  it('rejects a malformed attachment source (no base64 data) with 400', async () => {
    const res = await auth(request(makeServer()).post('/api/claude')).send({
      messages: [{ role: 'user', content: [{ type: 'image', source: null }] }],
    })
    expect(res.status).toBe(400)
    expect(claudeStream).not.toHaveBeenCalled()
  })

  it('accepts a normal-sized inline text-attachment block and streams', async () => {
    const res = await auth(request(makeServer()).post('/api/claude')).send({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '<attachment name="a.csv" type="text">\na,b\n1,2\n</attachment>' },
          { type: 'text', text: 'summarise this' },
        ],
      }],
    })
    expect(res.status).toBe(200)
    expect(claudeStream).toHaveBeenCalledOnce()
  })

  it('rejects an oversized inline text-attachment block (>512 KB) with 400, no upstream call', async () => {
    const huge = 'x'.repeat(512 * 1024 + 1) // one byte over TEXT_BLOCK_MAX_CHARS
    const res = await auth(request(makeServer()).post('/api/claude')).send({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `<attachment name="big.csv" type="text">\n${huge}\n</attachment>` },
          { type: 'text', text: 'go' },
        ],
      }],
    })
    expect(res.status).toBe(400)
    expect(claudeStream).not.toHaveBeenCalled()
  })

  it('accepts a >100 KB body on /api/claude (route limit is 35 MB, not the 100 KB global)', async () => {
    const big = 'x'.repeat(150 * 1024) // 150 KB of text — over the 100 KB global parser cap
    const res = await auth(request(makeServer()).post('/api/claude')).send({
      messages: [{ role: 'user', content: big }],
    })
    expect(res.status).toBe(200) // parsed fine under the 35 MB route limit
  })

  it('rejects a >100 KB body on an auth route (global parser stays at 100 KB)', async () => {
    const big = 'y'.repeat(150 * 1024)
    const res = await request(makeServer()).post('/api/auth/login').send({ username: big, password: 'x' })
    expect(res.status).toBe(413) // payload too large at the global 100 KB parser
  })
})
