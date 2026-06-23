import { describe, it, expect } from 'vitest'
import { createBIALData, bialDataClientScript } from '../bial-data-client.js'

const CONFIG = { appId: 'app-1', appKey: 'key-1', baseUrl: '/api', loginRequired: false }

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/** A fetch double that records calls and answers via `handler(url, opts)`. */
function mockFetch(handler) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts)
  }
  return { fetchImpl, calls }
}

function makeClient({ handler, token = 'TOK', config = CONFIG } = {}) {
  const { fetchImpl, calls } = mockFetch(handler ?? (() => jsonRes(200, {})))
  let stored = token
  const client = createBIALData({
    getConfig: () => config,
    getToken: () => stored,
    setToken: (t) => {
      stored = t
    },
    fetchImpl,
  })
  return { client, calls, getStored: () => stored }
}

describe('BIALData — CRUD hits /api/apps/:appId/records with X-App-Key (+ Bearer)', () => {
  it('save POSTs { collection, data } with the app key and bearer token', async () => {
    const { client, calls } = makeClient({ handler: () => jsonRes(201, { id: 'r1', data: { a: 1 } }) })
    const rec = await client.save('default', { a: 1 })
    expect(rec).toEqual({ id: 'r1', data: { a: 1 } })
    expect(calls[0].url).toBe('/api/apps/app-1/records')
    expect(calls[0].opts.method).toBe('POST')
    expect(calls[0].opts.headers['X-App-Key']).toBe('key-1')
    expect(calls[0].opts.headers['Authorization']).toBe('Bearer TOK')
    expect(JSON.parse(calls[0].opts.body)).toEqual({ collection: 'default', data: { a: 1 } })
  })

  it('list/get/update/remove hit the right URLs and unwrap the response', async () => {
    const handler = (url, opts) => {
      if (opts.method === 'GET' && url.includes('/records?')) return jsonRes(200, { records: [{ id: 'r1' }] })
      if (opts.method === 'GET') return jsonRes(200, { record: { id: 'r1', data: { a: 1 } } })
      if (opts.method === 'PATCH') return jsonRes(200, { record: { id: 'r1', data: { a: 2 } } })
      if (opts.method === 'DELETE') return jsonRes(200, { ok: true })
      return jsonRes(200, {})
    }
    const { client, calls } = makeClient({ handler })
    expect(await client.list('inspections', { limit: 10 })).toEqual([{ id: 'r1' }])
    expect(calls[0].url).toBe('/api/apps/app-1/records?collection=inspections&limit=10')
    expect((await client.get('inspections', 'r1')).data).toEqual({ a: 1 })
    expect(calls[1].url).toBe('/api/apps/app-1/records/r1')
    expect((await client.update('inspections', 'r1', { a: 2 })).data).toEqual({ a: 2 })
    expect(calls[2].opts.method).toBe('PATCH')
    expect(await client.remove('inspections', 'r1')).toEqual({ ok: true })
    expect(calls[3].opts.method).toBe('DELETE')
  })

  it('omits the Authorization header when there is no token (open app)', async () => {
    const { client, calls } = makeClient({ token: null, handler: () => jsonRes(201, { id: 'r1' }) })
    await client.save('default', { a: 1 })
    expect(calls[0].opts.headers['X-App-Key']).toBe('key-1')
    expect(calls[0].opts.headers['Authorization']).toBeUndefined()
  })

  it('a 401 surfaces a clear "please sign in" error', async () => {
    const { client } = makeClient({ token: null, handler: () => jsonRes(401, { error: { message: 'nope' } }) })
    await expect(client.list('default')).rejects.toThrow(/sign in/i)
  })

  it('a non-2xx surfaces the server’s uniform error message', async () => {
    const { client } = makeClient({ handler: () => jsonRes(413, { error: { message: 'quota full' } }) })
    await expect(client.save('default', { a: 1 })).rejects.toThrow(/quota full/)
  })
})

describe('BIALData — seedFromUpload idempotency', () => {
  it('seeds rows once; a second run does not duplicate them', async () => {
    const store = []
    const handler = (url, opts) => {
      if (opts.method === 'GET') return jsonRes(200, { records: store.map((d, i) => ({ id: 'r' + i, data: d })) })
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body)
        store.push(body.data)
        return jsonRes(201, { id: 'r' + (store.length - 1), data: body.data })
      }
      return jsonRes(200, {})
    }
    const { client } = makeClient({ handler })
    const rows = [{ tag: 'GEN-1' }, { tag: 'GEN-2' }]
    const first = await client.seedFromUpload('equipment', rows)
    expect(first).toEqual({ seeded: 2, skipped: false })
    expect(store).toHaveLength(2)
    const second = await client.seedFromUpload('equipment', rows)
    expect(second.skipped).toBe(true) // collection already has rows → skip
    expect(store).toHaveLength(2) // no duplication
  })

  it('with a dedupeKey, only previously-unseen rows are added', async () => {
    const store = [{ tag: 'GEN-1' }]
    const handler = (url, opts) => {
      if (opts.method === 'GET') return jsonRes(200, { records: store.map((d, i) => ({ id: 'r' + i, data: d })) })
      if (opts.method === 'POST') {
        store.push(JSON.parse(opts.body).data)
        return jsonRes(201, { id: 'x' })
      }
      return jsonRes(200, {})
    }
    const { client } = makeClient({ handler })
    const res = await client.seedFromUpload('equipment', [{ tag: 'GEN-1' }, { tag: 'GEN-2' }], { dedupeKey: 'tag' })
    expect(res.seeded).toBe(1) // GEN-1 already present, only GEN-2 added
    expect(store.map((d) => d.tag)).toEqual(['GEN-1', 'GEN-2'])
  })
})

describe('BIALData — login (shared portal login, in-memory token)', () => {
  it('login stores the access token in memory and returns the user; currentUser reflects it', async () => {
    const handler = (url, opts) => {
      if (url.endsWith('/auth/login')) return jsonRes(200, { accessToken: 'NEWTOK', refreshToken: 'SHOULD_BE_IGNORED', user: { username: 'alice' } })
      return jsonRes(200, {})
    }
    const { client, getStored } = makeClient({ token: null, handler })
    const out = await client.login('alice', 'pw')
    expect(out.user).toEqual({ username: 'alice' })
    expect(client.currentUser()).toEqual({ username: 'alice' })
    expect(getStored()).toBe('NEWTOK') // token set in memory (never localStorage)
  })

  it('a failed login throws a generic error', async () => {
    const { client } = makeClient({ token: null, handler: () => jsonRes(401, {}) })
    await expect(client.login('alice', 'bad')).rejects.toThrow(/username or password/i)
  })
})

describe('BIALData — archetype separation + injection hygiene', () => {
  it('creating the client makes no network calls (an upload-only app stays offline)', async () => {
    const { calls } = makeClient()
    expect(calls).toHaveLength(0)
  })

  it('the injected browser bootstrap reads window globals and NEVER touches localStorage', () => {
    const src = bialDataClientScript()
    expect(src).toContain('createBIALData')
    expect(src).toContain('window.BIALData')
    expect(src).toContain('window.__BIAL_CONFIG')
    expect(src).toContain('window.__BIAL_TOKEN')
    expect(src).not.toContain('localStorage') // opaque-origin frame can't read it anyway, and must not try
  })
})
