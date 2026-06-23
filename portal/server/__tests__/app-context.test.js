import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAppContext } from '../app-context.js'
import { createAppRegistryRepo } from '../app-registry-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'
import { signAccessToken } from '../auth/tokens.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const SEED = [
  { _id: 'app-open', appKey: 'key-open', status: 'approved', loginRequired: false },
  { _id: 'app-login', appKey: 'key-login', status: 'approved', loginRequired: true },
  { _id: 'app-draft', appKey: 'key-draft', status: 'draft', loginRequired: false },
  { _id: 'app-disabled', appKey: 'key-dis', status: 'disabled', loginRequired: false },
  { _id: 'app-rejected', appKey: 'key-rej', status: 'rejected', loginRequired: false },
]

/** Mount requireAppKey + requireLoginIfRequired on a :appId route with a terminal echo. */
function appWith(container) {
  const registryRepo = createAppRegistryRepo(container)
  const { requireAppKey, requireLoginIfRequired } = createAppContext({ registryRepo })
  const app = express()
  app.use(express.json())
  app.post('/api/apps/:appId/records', requireAppKey, requireLoginIfRequired, (req, res) =>
    res.json({ appCtx: req.appCtx, sub: req.user?.sub ?? null }),
  )
  return { app, container, registryRepo }
}

const token = (sub = 'alice') => signAccessToken({ sub, username: sub, role: 'user' })
const post = (app, appId) => request(app).post(`/api/apps/${appId}/records`)

describe('requireAppKey — key resolution + status gate', () => {
  it('missing key → 401; unknown key → 401', async () => {
    const { app } = appWith(makeFakeAppRegistryContainer(SEED))
    expect((await post(app, 'app-open')).status).toBe(401) // no X-App-Key
    expect((await post(app, 'app-open').set('X-App-Key', 'nope')).status).toBe(401)
  })

  it('a draft app passes (build-time writes intended); disabled → 403; rejected → 403', async () => {
    const { app } = appWith(makeFakeAppRegistryContainer(SEED))
    const draft = await post(app, 'app-draft').set('X-App-Key', 'key-draft')
    expect(draft.status).toBe(200)
    expect(draft.body.appCtx).toEqual({ appId: 'app-draft', loginRequired: false, status: 'draft' })
    expect((await post(app, 'app-disabled').set('X-App-Key', 'key-dis')).status).toBe(403)
    expect((await post(app, 'app-rejected').set('X-App-Key', 'key-rej')).status).toBe(403)
  })

  it('URL :appId ≠ the key’s app → 404 (no cross-app leak)', async () => {
    const { app } = appWith(makeFakeAppRegistryContainer(SEED))
    // valid key for app-open, but used on app-login's URL
    const res = await post(app, 'app-login').set('X-App-Key', 'key-open')
    expect(res.status).toBe(404)
  })
})

describe('requireLoginIfRequired — live loginRequired gate', () => {
  it('loginRequired:false → anonymous allowed, actor null', async () => {
    const { app } = appWith(makeFakeAppRegistryContainer(SEED))
    const res = await post(app, 'app-open').set('X-App-Key', 'key-open')
    expect(res.status).toBe(200)
    expect(res.body.sub).toBeNull()
  })

  it('loginRequired:true + no Bearer → 401; with a valid portal token → passes, req.user.sub set', async () => {
    const { app } = appWith(makeFakeAppRegistryContainer(SEED))
    const noTok = await post(app, 'app-login').set('X-App-Key', 'key-login')
    expect(noTok.status).toBe(401)
    const withTok = await post(app, 'app-login').set('X-App-Key', 'key-login').set('Authorization', `Bearer ${token('alice')}`)
    expect(withTok.status).toBe(200)
    expect(withTok.body.sub).toBe('alice')
  })

  it('flipping loginRequired in the registry changes the next request (live read — can’t be prompted away)', async () => {
    const container = makeFakeAppRegistryContainer(SEED)
    const { app, registryRepo } = appWith(container)
    // initially open: anonymous passes
    expect((await post(app, 'app-open').set('X-App-Key', 'key-open')).status).toBe(200)
    // admin flips loginRequired on
    await registryRepo.patchApp('app-open', { loginRequired: true })
    // the very next anonymous request is now rejected
    expect((await post(app, 'app-open').set('X-App-Key', 'key-open')).status).toBe(401)
    // and a valid token now passes
    const ok = await post(app, 'app-open').set('X-App-Key', 'key-open').set('Authorization', `Bearer ${token()}`)
    expect(ok.status).toBe(200)
  })
})

describe('createAppContext — guards', () => {
  it('throws when registryRepo is omitted', () => {
    expect(() => createAppContext({})).toThrow(/registryRepo is required/)
  })
})
