import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRunnerRouter } from '../runner.js'
import { createAppRegistryRepo } from '../app-registry-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'

const COMPILED = 'function PreviewApp(){ return React.createElement("div", null, "hosted app") }'
const snap = { approvedSnapshot: { compiled: COMPILED, src: 'x', entry: 'PreviewApp', by: 'admin' } }

const SEED = [
  { _id: 'app-open', appKey: 'k1', status: 'approved', loginRequired: false, code: snap },
  { _id: 'app-login', appKey: 'k2', status: 'approved', loginRequired: true, code: snap },
  { _id: 'app-rereview', appKey: 'k3', status: 'pending', loginRequired: false, code: { source: { src: 'new' }, ...snap } },
  { _id: 'app-draft', appKey: 'k4', status: 'draft', loginRequired: false },
  { _id: 'app-disabled', appKey: 'k5', status: 'disabled', loginRequired: false, code: snap },
  { _id: 'app-never-approved', appKey: 'k6', status: 'pending', loginRequired: false }, // no snapshot yet
]

function harness() {
  const registryRepo = createAppRegistryRepo(makeFakeAppRegistryContainer(SEED))
  const app = express()
  app.use('/apps', createRunnerRouter({ registryRepo }))
  return app
}

describe('runner — shell (/apps/:appId)', () => {
  it('serves a same-origin shell that embeds a sandboxed (no allow-same-origin) app frame', async () => {
    const res = await request(harness()).get('/apps/app-open')
    expect(res.status).toBe(200)
    // allow-forms lets a generated app's <form onSubmit> handler fire; allow-downloads
    // lets it trigger a SAS <a download> navigation (native form navigation is blocked
    // by the frame CSP's form-action 'none'); still NO allow-same-origin, so the frame
    // can't read the portal session.
    expect(res.text).toContain("setAttribute('sandbox','allow-scripts allow-forms allow-downloads')")
    expect(res.text).not.toContain('allow-same-origin') // can't read the portal session
    expect(res.text).toContain('/apps/app-open/frame') // embeds the frame route
    expect(res.text).toContain('"loginRequired":false')
    // the access token AND the signed-in user are injected (so the app's currentUser()
    // works without its own login form). The exact payload shape below also proves the
    // refresh token is NOT among what's posted to the frame.
    expect(res.text).toContain('postMessage({ config: CONFIG, accessToken: accessToken, user: currentUser }')
    // Regression guard: posting into an opaque-origin (null) frame is inherently '*' —
    // U5 must NOT tighten/loosen this while editing the shell.
    expect(res.text).toContain("user: currentUser }, '*')")
  })

  it('a login app carries loginRequired:true and renders the login box markup', async () => {
    const res = await request(harness()).get('/apps/app-login')
    expect(res.status).toBe(200)
    expect(res.text).toContain('"loginRequired":true')
    expect(res.text).toContain('id="loginForm"')
    expect(res.text).toContain('/api/auth/login')
  })

  it('a previously-approved app now pending (re-review) still serves its prior snapshot', async () => {
    expect((await request(harness()).get('/apps/app-rereview')).status).toBe(200)
  })

  it('draft / disabled / never-approved / unknown apps → 404', async () => {
    const app = harness()
    expect((await request(app).get('/apps/app-draft')).status).toBe(404)
    expect((await request(app).get('/apps/app-disabled')).status).toBe(404)
    expect((await request(app).get('/apps/app-never-approved')).status).toBe(404)
    expect((await request(app).get('/apps/ghost')).status).toBe(404)
  })
})

describe('runner — frame (/apps/:appId/frame)', () => {
  it('serves the pre-compiled snapshot under a CSP with NO unsafe-eval and NO @babel/standalone', async () => {
    const res = await request(harness()).get('/apps/app-open/frame')
    expect(res.status).toBe(200)
    expect(res.text).toContain('PreviewApp') // the pre-compiled app code is inlined
    expect(res.text).toContain('window.BIALData') // BIALData client mounted
    expect(res.text).not.toContain('@babel/standalone') // no runtime Babel
    const csp = res.headers['content-security-policy']
    expect(csp).not.toContain('unsafe-eval') // pre-compiled → no eval needed
    expect(csp).toMatch(/connect-src[^;]*(127\.0\.0\.1|localhost):\d+/) // scoped to the portal origin
    // connect-src must NOT have been widened with a blob host (inline render rides fetch).
    expect(csp).not.toMatch(/connect-src[^;]*blob:/)
    // blob: is added to img-src (for fetch('/content')→createObjectURL→<img src=blob:>),
    // but NOT a bare https: NOR the portal origin (either would be a token-beacon egress).
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).not.toMatch(/img-src[^;]*https:/)
    expect(csp).not.toMatch(/img-src[^;]*(127\.0\.0\.1|localhost):\d+/) // no portal origin in img-src
    // allow-forms is enabled on the frame, so a native form navigation must be blocked
    // outright — a token-bearing <form> can't POST window.__BIAL_TOKEN off-origin.
    expect(csp).toContain("form-action 'none'")
  })

  it('the frame route 404s for an unservable app', async () => {
    expect((await request(harness()).get('/apps/app-draft/frame')).status).toBe(404)
  })
})
