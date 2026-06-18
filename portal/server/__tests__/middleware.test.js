import { describe, it, expect, beforeAll, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { requireAuth, requireAdmin } from '../auth/middleware.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
}

function run(authorization) {
  const req = { headers: authorization ? { authorization } : {} }
  const res = makeRes()
  const next = vi.fn()
  requireAuth(req, res, next)
  return { req, res, next }
}

describe('requireAuth', () => {
  it('valid token → next() called and req.user populated', () => {
    const token = signAccessToken({ sub: 'alice', username: 'alice', role: 'admin' })
    const { req, res, next } = run(`Bearer ${token}`)
    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBeNull()
    expect(req.user).toMatchObject({ sub: 'alice', username: 'alice', role: 'admin' })
  })

  it('missing header → 401 and next() not called', () => {
    const { res, next } = run(undefined)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('malformed header (Bearer, no token) → 401', () => {
    const { res, next } = run('Bearer')
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('wrong scheme → 401', () => {
    const token = signAccessToken({ sub: 'alice', username: 'alice', role: 'user' })
    const { res, next } = run(`Basic ${token}`)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('expired token → 401', () => {
    process.env.ACCESS_TOKEN_TTL = '-120s'
    const token = signAccessToken({ sub: 'alice', username: 'alice', role: 'user' })
    delete process.env.ACCESS_TOKEN_TTL
    const { res, next } = run(`Bearer ${token}`)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('invalid signature → 401', () => {
    const forged = jwt.sign({ sub: 'mallory' }, 'a-different-secret', { algorithm: 'HS256' })
    const { res, next } = run(`Bearer ${forged}`)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('uses the { error: { message } } response shape', () => {
    const { res } = run(undefined)
    expect(res.body?.error?.message).toBeTypeOf('string')
  })
})

describe('requireAdmin', () => {
  const runAdmin = (user) => {
    const req = { user }
    const res = makeRes()
    const next = vi.fn()
    requireAdmin(req, res, next)
    return { res, next }
  }

  it('admin role → next() called, no status set', () => {
    const { res, next } = runAdmin({ sub: 'a', role: 'admin' })
    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBeNull()
  })

  it('non-admin role → 403, next() not called', () => {
    const { res, next } = runAdmin({ sub: 'b', role: 'user' })
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
    expect(res.body?.error?.message).toBeTypeOf('string')
  })

  it('missing user/role → 403 (fails closed)', () => {
    expect(runAdmin(undefined).res.statusCode).toBe(403)
    expect(runAdmin({ sub: 'c' }).res.statusCode).toBe(403)
  })
})
