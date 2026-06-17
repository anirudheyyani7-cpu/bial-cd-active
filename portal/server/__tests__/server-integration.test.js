import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../../server.js'
import { createUsersRepo } from '../users-repo.js'
import { signAccessToken } from '../auth/tokens.js'
import { hashPassword } from '../auth/password.js'
import { makeFakeContainer } from './fakeCosmos.js'

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

function makeClaudeClient() {
  claudeStream = vi.fn(async () =>
    (async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }
    })(),
  )
  return { messages: { stream: claudeStream } }
}

function makeServer() {
  const container = makeFakeContainer([])
  const repo = createUsersRepo(container)
  return createApp({ repo, claudeClient: makeClaudeClient(), distDir })
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
    const e2eApp = createApp({ repo: createUsersRepo(container), claudeClient: makeClaudeClient(), distDir })

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
