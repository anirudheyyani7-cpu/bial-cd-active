import { describe, it, expect, vi, afterEach } from 'vitest'
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

describe('BIALData — query + distinct (search / pagination / filter)', () => {
  it('query builds /records/search with all params and returns the paged envelope', async () => {
    const envelope = { items: [{ id: 'r1', data: { gate: 'A2' } }], total: 1, page: 2, pageSize: 25, totalPages: 1 }
    const { client, calls } = makeClient({ handler: () => jsonRes(200, envelope) })
    const out = await client.query('inspections', { q: 'sensor', page: 2, pageSize: 25, sort: 'gate', order: 'asc', filter: { status: 'Fail' } })
    expect(out).toEqual(envelope)
    const url = calls[0].url
    expect(url.startsWith('/api/apps/app-1/records/search?')).toBe(true)
    expect(url).toContain('collection=inspections')
    expect(url).toContain('q=sensor')
    expect(url).toContain('page=2')
    expect(url).toContain('pageSize=25')
    expect(url).toContain('sort=gate')
    expect(url).toContain('order=asc')
    expect(url).toContain('filter=' + encodeURIComponent(JSON.stringify({ status: 'Fail' })))
    expect(calls[0].opts.method).toBe('GET')
    expect(calls[0].opts.headers['X-App-Key']).toBe('key-1')
  })

  it('query with no opts still hits /records/search and defaults the envelope on an empty body', async () => {
    const { client, calls } = makeClient({ handler: () => jsonRes(200, null) })
    const out = await client.query('inspections')
    expect(calls[0].url).toBe('/api/apps/app-1/records/search?collection=inspections')
    expect(out).toEqual({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 })
  })

  it('distinct hits /records/distinct?collection=&field= and unwraps values', async () => {
    const { client, calls } = makeClient({ handler: () => jsonRes(200, { values: ['Pass', 'Fail'] }) })
    expect(await client.distinct('inspections', 'status')).toEqual(['Pass', 'Fail'])
    expect(calls[0].url).toBe('/api/apps/app-1/records/distinct?collection=inspections&field=status')
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

describe('BIALData — platform-injected session (Layer 2: deployed apps never build a login form)', () => {
  it('currentUser() returns the platform-injected user without any in-app login', () => {
    const client = createBIALData({
      getConfig: () => CONFIG,
      getToken: () => 'TOK',
      setToken: () => {},
      getUser: () => ({ username: 'anant' }),
      fetchImpl: async () => jsonRes(200, {}),
    })
    expect(client.currentUser()).toEqual({ username: 'anant' })
  })

  it('login() reuses the injected session WITHOUT a network call (no credentials forwarded)', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonRes(200, {}))
    const client = createBIALData({
      getConfig: () => CONFIG,
      getToken: () => 'TOK',
      setToken: () => {},
      getUser: () => ({ username: 'anant' }),
      fetchImpl,
    })
    const out = await client.login('ignored', 'ignored')
    expect(out.user).toEqual({ username: 'anant' }) // the shell already signed them in
    expect(calls).toHaveLength(0) // never hits /auth/login — no creds leave the sandbox
  })

  it('login() surfaces a clear "sign in from the portal" message when the sandboxed frame cannot reach the endpoint', async () => {
    const client = createBIALData({
      getConfig: () => CONFIG,
      getToken: () => null,
      setToken: () => {},
      // no injected user + a fetch that REJECTS the way a blocked cross-origin call does
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await expect(client.login('a', 'b')).rejects.toThrow(/sign in from the BIAL portal/i)
  })

  it('the browser bootstrap wires the injected user (window.__BIAL_USER + getUser), still no localStorage', () => {
    const src = bialDataClientScript()
    expect(src).toContain('window.__BIAL_USER')
    expect(src).toContain('getUser')
    expect(src).not.toContain('localStorage')
  })
})

describe('BIALData — file methods (/api/apps/:appId/files; proxy upload, SAS download, content proxy)', () => {
  afterEach(() => vi.unstubAllGlobals())

  // A fake `document` so the in-frame `<a download>` primitive is observable.
  function stubAnchorDom() {
    const anchors = []
    const body = {
      appendChild: (a) => {
        a.parentNode = body
      },
      removeChild: (a) => {
        a.parentNode = null
      },
    }
    const fakeDoc = {
      body,
      createElement: (tag) => {
        const a = { tag, href: '', download: '', parentNode: null, clicked: 0, click() { this.clicked++ } }
        anchors.push(a)
        return a
      },
    }
    vi.stubGlobal('document', fakeDoc)
    return { anchors }
  }

  // A byte (Blob) response for the /content proxy path.
  const blobRes = (status, blob) => ({ ok: status >= 200 && status < 300, status, blob: async () => blob })

  it('uploadFile reads a File to base64 and POSTs { filename, contentType, base64 } with X-App-Key + Bearer', async () => {
    const bytes = Uint8Array.from([72, 105, 33]) // "Hi!"
    const file = new File([bytes], 'report.csv', { type: 'text/csv' })
    const { client, calls } = makeClient({ handler: () => jsonRes(201, { fileId: 'f1', filename: 'report.csv', size: 3 }) })
    const meta = await client.uploadFile(file, { collection: 'reports' })
    expect(meta).toEqual({ fileId: 'f1', filename: 'report.csv', size: 3 })
    expect(calls[0].url).toBe('/api/apps/app-1/files')
    expect(calls[0].opts.method).toBe('POST')
    expect(calls[0].opts.headers['X-App-Key']).toBe('key-1')
    expect(calls[0].opts.headers['Authorization']).toBe('Bearer TOK')
    const body = JSON.parse(calls[0].opts.body)
    expect(body).toEqual({ filename: 'report.csv', contentType: 'text/csv', base64: Buffer.from(bytes).toString('base64'), collection: 'reports' })
  })

  it('uploadFile accepts a plain { filename, contentType, base64 } object too (no collection ⇒ default)', async () => {
    const { client, calls } = makeClient({ handler: () => jsonRes(201, { fileId: 'f2' }) })
    await client.uploadFile({ filename: 'a.json', contentType: 'application/json', base64: 'eyJhIjoxfQ==' })
    const body = JSON.parse(calls[0].opts.body)
    expect(body).toEqual({ filename: 'a.json', contentType: 'application/json', base64: 'eyJhIjoxfQ==' })
    expect('collection' in body).toBe(false)
  })

  it('listFiles is collection-first like list, GETs ?collection=&limit= and unwraps { files }', async () => {
    const { client, calls } = makeClient({ handler: () => jsonRes(200, { files: [{ fileId: 'f1' }] }) })
    expect(await client.listFiles('reports', { limit: 5 })).toEqual([{ fileId: 'f1' }])
    expect(calls[0].url).toBe('/api/apps/app-1/files?collection=reports&limit=5')
    expect(calls[0].opts.headers['X-App-Key']).toBe('key-1')
  })

  it('getFile / getDownloadUrl / removeFile hit the right endpoints and unwrap their responses', async () => {
    const handler = (url, opts) => {
      if (opts.method === 'DELETE') return jsonRes(200, { ok: true })
      if (url.endsWith('/url')) return jsonRes(200, { url: 'https://blob/x?sig=1', expiresAt: 'soon' })
      return jsonRes(200, { file: { fileId: 'f1', filename: 'r.csv' } })
    }
    const { client, calls } = makeClient({ handler })
    expect(await client.getFile('f1')).toEqual({ fileId: 'f1', filename: 'r.csv' })
    expect(calls[0].url).toBe('/api/apps/app-1/files/f1')
    expect(await client.getDownloadUrl('f1')).toEqual({ url: 'https://blob/x?sig=1', expiresAt: 'soon' })
    expect(calls[1].url).toBe('/api/apps/app-1/files/f1/url')
    expect(await client.removeFile('f1')).toEqual({ ok: true })
    expect(calls[2].url).toBe('/api/apps/app-1/files/f1')
    expect(calls[2].opts.method).toBe('DELETE')
  })

  it('downloadFile mints a SAS and assigns the https SAS URL to an <a download> (no /content fetch)', async () => {
    const sas = 'https://acct.blob.core.windows.net/c/apps/app-1/f1?sp=r&sig=abc&rscd=attachment'
    const { anchors } = stubAnchorDom()
    let contentHit = false
    const handler = (url) => {
      if (url.endsWith('/content')) { contentHit = true; return blobRes(200, new Blob([Uint8Array.from([1])])) }
      if (url.endsWith('/url')) return jsonRes(200, { url: sas, expiresAt: 'soon' })
      return jsonRes(200, {})
    }
    const { client, calls } = makeClient({ handler })
    const out = await client.downloadFile('f1', 'report.csv')
    expect(out).toEqual({ downloaded: true, via: 'sas' })
    expect(calls[0].url).toBe('/api/apps/app-1/files/f1/url')
    expect(contentHit).toBe(false) // SAS path bypasses the proxy
    expect(anchors).toHaveLength(1)
    expect(anchors[0].href).toBe(sas)
    expect(anchors[0].download).toBe('report.csv')
    expect(anchors[0].clicked).toBe(1)
  })

  it('downloadFile falls back to /content (blob: URL) on a 501 from /url, never assigning a non-https href', async () => {
    const { anchors } = stubAnchorDom()
    let contentHit = false
    const handler = (url) => {
      if (url.endsWith('/url')) return jsonRes(501, { error: { message: 'no signer' } })
      if (url.endsWith('/content')) { contentHit = true; return blobRes(200, new Blob([Uint8Array.from([9, 9])], { type: 'text/csv' })) }
      return jsonRes(200, {})
    }
    const { client } = makeClient({ handler })
    const out = await client.downloadFile('f1', 'report.csv')
    expect(out).toEqual({ downloaded: true, via: 'content' })
    expect(contentHit).toBe(true)
    expect(anchors[0].href.startsWith('blob:')).toBe(true)
    expect(anchors[0].href.startsWith('https://')).toBe(false)
  })

  it('downloadFile refuses a tampered (javascript:) /url response and falls back to /content', async () => {
    const { anchors } = stubAnchorDom()
    const handler = (url) => {
      if (url.endsWith('/url')) return jsonRes(200, { url: 'javascript:alert(document.cookie)' })
      if (url.endsWith('/content')) return blobRes(200, new Blob([Uint8Array.from([1])]))
      return jsonRes(200, {})
    }
    const { client } = makeClient({ handler })
    const out = await client.downloadFile('f1')
    expect(out.via).toBe('content')
    expect(anchors[0].href.startsWith('blob:')).toBe(true)
    expect(anchors[0].href).not.toContain('javascript:') // the tampered value never reached the anchor
  })

  it('downloadFile refuses a non-https (http://attacker) /url response and falls back to /content', async () => {
    const { anchors } = stubAnchorDom()
    let contentHit = false
    const handler = (url) => {
      // a syntactically-valid but NON-https URL pointing off-origin — the https-scheme
      // guard must reject it (not just javascript:/data:) and use the /content proxy.
      if (url.endsWith('/url')) return jsonRes(200, { url: 'http://attacker.example/file', expiresAt: 'soon' })
      if (url.endsWith('/content')) { contentHit = true; return blobRes(200, new Blob([Uint8Array.from([1])])) }
      return jsonRes(200, {})
    }
    const { client } = makeClient({ handler })
    const out = await client.downloadFile('f1', 'report.csv')
    expect(out.via).toBe('content') // not 'sas' — the http URL was refused
    expect(contentHit).toBe(true)
    expect(anchors[0].href.startsWith('blob:')).toBe(true)
    expect(anchors[0].href).not.toContain('attacker.example') // the http URL never reached the anchor
  })

  it('a server error surfaces its `code` on the thrown Error (e.g. FILE_QUOTA_EXCEEDED) so app code can branch', async () => {
    const handler = () => jsonRes(413, { error: { message: 'over quota', code: 'FILE_QUOTA_EXCEEDED' } })
    const { client } = makeClient({ handler })
    await expect(
      client.uploadFile({ filename: 'a.csv', contentType: 'text/csv', base64: 'AQ==' }),
    ).rejects.toMatchObject({ message: 'over quota', code: 'FILE_QUOTA_EXCEEDED' })
  })

  it('fileObjectUrl fetches /content WITH headers and returns a blob: URL (never a portal-origin string)', async () => {
    const handler = (url) => {
      if (url.endsWith('/content')) return blobRes(200, new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }))
      return jsonRes(200, {})
    }
    const { client, calls } = makeClient({ handler })
    const objUrl = await client.fileObjectUrl('f1')
    expect(objUrl.startsWith('blob:')).toBe(true)
    expect(calls[0].url).toBe('/api/apps/app-1/files/f1/content')
    expect(calls[0].opts.headers['X-App-Key']).toBe('key-1')
    expect(calls[0].opts.headers['Authorization']).toBe('Bearer TOK')
    URL.revokeObjectURL(objUrl)
  })

  it('a login app with no token surfaces a clear "sign in" error on upload (uses the injected token, never localStorage)', async () => {
    const { client } = makeClient({ token: null, handler: () => jsonRes(401, { error: { message: 'nope' } }) })
    await expect(client.uploadFile({ filename: 'a.csv', contentType: 'text/csv', base64: 'AQ==' })).rejects.toThrow(/sign in/i)
  })

  it('the injected browser bootstrap exposes the file methods through window.BIALData with no localStorage', () => {
    const src = bialDataClientScript()
    for (const m of ['uploadFile', 'listFiles', 'getFile', 'getDownloadUrl', 'downloadFile', 'fileObjectUrl', 'removeFile', 'parseFile']) {
      expect(src).toContain(m)
    }
    expect(src).not.toContain('localStorage')
  })
})

describe('BIALData — parseFile (/api/apps/:appId/parse)', () => {
  it('reads a File to base64 and POSTs { filename, contentType, base64 } (+ optional sheet)', async () => {
    const bytes = Uint8Array.from([80, 75, 3, 4]) // "PK\x03\x04"
    const file = new File([bytes], 'flights.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const { client, calls } = makeClient({ handler: () => jsonRes(200, { kind: 'spreadsheet', sheets: ['A', 'B'], sheet: 'B', columns: ['x'], rows: [{ x: 1 }] }) })
    const out = await client.parseFile(file, { sheet: 'B' })
    expect(out.kind).toBe('spreadsheet')
    expect(out.sheet).toBe('B')
    expect(calls[0].url).toBe('/api/apps/app-1/parse')
    expect(calls[0].opts.method).toBe('POST')
    expect(calls[0].opts.headers['X-App-Key']).toBe('key-1')
    expect(calls[0].opts.headers['Authorization']).toBe('Bearer TOK')
    const body = JSON.parse(calls[0].opts.body)
    expect(body).toEqual({
      filename: 'flights.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: Buffer.from(bytes).toString('base64'),
      sheet: 'B',
    })
  })

  it('accepts a stored fileId string and POSTs { fileId }', async () => {
    const { client, calls } = makeClient({ handler: () => jsonRes(200, { kind: 'spreadsheet', sheets: ['S'], sheet: 'S', columns: [], rows: [] }) })
    await client.parseFile('file-123')
    expect(JSON.parse(calls[0].opts.body)).toEqual({ fileId: 'file-123' })
  })

  it('accepts a plain { filename, contentType, base64 } object and a { fileId } object', async () => {
    const { client, calls } = makeClient({ handler: () => jsonRes(200, {}) })
    await client.parseFile({ filename: 'd.csv', contentType: 'text/csv', base64: 'YSxiCjEsMg==' })
    expect(JSON.parse(calls[0].opts.body)).toEqual({ filename: 'd.csv', contentType: 'text/csv', base64: 'YSxiCjEsMg==' })
    await client.parseFile({ fileId: 'f9' }, { sheet: 'Sheet2' })
    expect(JSON.parse(calls[1].opts.body)).toEqual({ fileId: 'f9', sheet: 'Sheet2' })
  })

  it('rejects an invalid input shape before any network call', async () => {
    const { client, calls } = makeClient()
    await expect(client.parseFile(42)).rejects.toThrow(/parseFile needs/)
    expect(calls).toHaveLength(0)
  })

  it('surfaces a server parse error message + code', async () => {
    const { client } = makeClient({ handler: () => jsonRes(415, { error: { message: 'cannot parse', code: 'UNSUPPORTED_TYPE' } }) })
    await expect(client.parseFile('f1')).rejects.toMatchObject({ message: 'cannot parse', code: 'UNSUPPORTED_TYPE' })
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
