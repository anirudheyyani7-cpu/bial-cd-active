/**
 * `BIALData` — the documented data + login interface the GENERATED app code uses
 * (Decisions 1, 4, 6, 8; U13). Injected into BOTH the builder preview (`/preview`)
 * and the deployed runner (`/apps/:appId/frame`); both run in an opaque-origin
 * sandboxed iframe, so this client NEVER reads `localStorage` — it reads the app
 * config and the short-lived access token from values injected via postMessage
 * (`window.__BIAL_CONFIG`, `window.__BIAL_TOKEN`).
 *
 * POC tradeoff (recorded, not hidden): the injected `window.__BIAL_TOKEN` is a
 * portal ACCESS token (15m) that also authorizes `/api/claude`. It is read by
 * untrusted model code inside a sandboxed frame whose CSP `connect-src` is scoped
 * to the Data-Service origin (no external exfiltration) and whose `/api/claude`
 * reach is capped by the per-user daily limit; the REFRESH token is NEVER injected
 * (it stays in the portal origin's localStorage, which this opaque-origin frame
 * cannot read). The hardening — an app-bound, audience-scoped data pass — is the
 * #1 deferred follow-up.
 *
 * `createBIALData` is a self-contained factory (no module imports) so its source
 * can be serialized with `.toString()` and inlined into the iframe shells, AND
 * unit-tested directly with an injected fetch/config/token. The browser bootstrap
 * (`bialDataClientScript`) wires the injectables to the window globals.
 */

/**
 * Build the BIALData client. SELF-CONTAINED — references only its parameters and
 * standard globals (JSON), so `.toString()` yields inlinable source.
 *
 * @param {object} deps
 * @param {() => object} deps.getConfig - returns { appId, appKey, baseUrl, loginRequired }
 * @param {() => (string|null)} deps.getToken - returns the current access token (or null)
 * @param {(t: string|null) => void} deps.setToken - stores a token after login (in-memory only)
 * @param {Function} deps.fetchImpl - a fetch implementation
 * @param {() => (object|null)} [deps.getUser] - returns the platform-injected signed-in
 *   user (the shell signs in and posts it down), so `currentUser()` works WITHOUT the
 *   app collecting credentials. Optional (absent in unit tests / the direct-login path).
 */
export function createBIALData({ getConfig, getToken, setToken, fetchImpl, getUser }) {
  function recordsUrl(suffix) {
    const { baseUrl, appId } = getConfig()
    return baseUrl + '/apps/' + appId + '/records' + (suffix || '')
  }

  function filesUrl(suffix) {
    const { baseUrl, appId } = getConfig()
    return baseUrl + '/apps/' + appId + '/files' + (suffix || '')
  }

  /** The X-App-Key (+ Bearer) headers every data/file request carries. The Content-Type
   *  branch is request-shaped and stays in `call`; the byte-proxy fetch reuses these. */
  function baseHeaders() {
    const { appKey } = getConfig()
    const headers = { 'X-App-Key': appKey }
    const token = getToken()
    if (token) headers['Authorization'] = 'Bearer ' + token
    return headers
  }

  async function call(url, method, body) {
    const headers = baseHeaders()
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetchImpl(url, {
      method: method,
      headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401) {
      throw new Error('Please sign in to use this app.')
    }
    if (!res.ok) {
      let message = 'Request failed (' + res.status + ').'
      let code = null
      try {
        const err = await res.json()
        if (err && err.error && err.error.message) message = err.error.message
        if (err && err.error && err.error.code) code = err.error.code
      } catch (e) {
        // non-JSON error body — keep the generic message
      }
      // Surface the server error `code` (e.g. FILE_QUOTA_EXCEEDED) so generated app
      // code can branch on it rather than string-matching the message.
      const e = new Error(message)
      if (code) e.code = code
      throw e
    }
    if (res.status === 204) return null
    return res.json()
  }

  /** Create a record in `collection`; returns the created record `{ id, ... }`. */
  function save(collection, data) {
    return call(recordsUrl(), 'POST', { collection: collection, data: data })
  }

  /** List records in `collection` (newest-first). `opts.limit` caps the page. Returns an array. */
  async function list(collection, opts) {
    const params = []
    if (collection) params.push('collection=' + encodeURIComponent(collection))
    if (opts && opts.limit) params.push('limit=' + encodeURIComponent(opts.limit))
    const suffix = params.length ? '?' + params.join('&') : ''
    const out = await call(recordsUrl(suffix), 'GET')
    return (out && out.records) || []
  }

  /**
   * Generic paged SEARCH (use for any search box or paged table — do NOT fetch
   * everything with `list` and filter client-side). `opts.q` matches free-text
   * across ALL fields; `opts.filter` is `{ field: value }` equality on your `.data`
   * fields; `opts.sort` is a `.data` field (or 'createdAt'/'updatedAt'); `opts.order`
   * is 'asc'|'desc'; `opts.page`/`opts.pageSize` page the results. Returns
   * `{ items, total, page, pageSize, totalPages }`.
   */
  async function query(collection, opts) {
    opts = opts || {}
    const params = []
    if (collection) params.push('collection=' + encodeURIComponent(collection))
    if (opts.q) params.push('q=' + encodeURIComponent(opts.q))
    if (opts.page) params.push('page=' + encodeURIComponent(opts.page))
    if (opts.pageSize) params.push('pageSize=' + encodeURIComponent(opts.pageSize))
    if (opts.sort) params.push('sort=' + encodeURIComponent(opts.sort))
    if (opts.order) params.push('order=' + encodeURIComponent(opts.order))
    if (opts.filter) params.push('filter=' + encodeURIComponent(JSON.stringify(opts.filter)))
    const suffix = '/search' + (params.length ? '?' + params.join('&') : '')
    const out = await call(recordsUrl(suffix), 'GET')
    return out || { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 }
  }

  /** Unique values of `data.<field>` in `collection` (for filter dropdowns / chips). Returns an array. */
  async function distinct(collection, field) {
    const params = ['field=' + encodeURIComponent(field)]
    if (collection) params.unshift('collection=' + encodeURIComponent(collection))
    const out = await call(recordsUrl('/distinct?' + params.join('&')), 'GET')
    return (out && out.values) || []
  }

  /** Read one record by id. Returns the record or null on 404. */
  async function get(collection, id) {
    const out = await call(recordsUrl('/' + encodeURIComponent(id)), 'GET')
    return (out && out.record) || null
  }

  /** PATCH-merge `data` into a record; returns the updated record. */
  async function update(collection, id, data) {
    const out = await call(recordsUrl('/' + encodeURIComponent(id)), 'PATCH', { data: data })
    return (out && out.record) || null
  }

  /** Hard-delete a record; returns `{ ok: true }`. */
  function remove(collection, id) {
    return call(recordsUrl('/' + encodeURIComponent(id)), 'DELETE')
  }

  /**
   * Idempotently seed parsed upload rows into `collection` on first run. With
   * `opts.dedupeKey`, only rows whose key value is not already present are added
   * (re-runnable). Without it, seeding is skipped entirely once the collection has
   * ANY rows — so a refresh/redeploy never duplicates the reference data.
   *
   * POC limitation: the `dedupeKey` "already present" check reads only the newest
   * 500 rows (the Data Service list cap), so it is reliable for reference sets up to
   * ~500 rows; a larger set could re-insert older rows on a re-seed. For big seed
   * sets prefer the no-`dedupeKey` (skip-if-non-empty) mode, which stays idempotent
   * at any size. A server-side upsert keyed on (appId, collection, dedupeKey) is the
   * proper fix and is deferred past the POC.
   */
  async function seedFromUpload(collection, rows, opts) {
    opts = opts || {}
    if (!Array.isArray(rows) || rows.length === 0) return { seeded: 0, skipped: true }
    const existing = await list(collection, { limit: 500 })
    if (opts.dedupeKey) {
      const seen = {}
      for (let i = 0; i < existing.length; i++) {
        const v = existing[i].data ? existing[i].data[opts.dedupeKey] : undefined
        if (v !== undefined) seen[v] = true
      }
      const fresh = rows.filter(function (row) {
        return !seen[row[opts.dedupeKey]]
      })
      for (let i = 0; i < fresh.length; i++) await save(collection, fresh[i])
      return { seeded: fresh.length, skipped: false }
    }
    if (existing.length > 0) return { seeded: 0, skipped: true } // already seeded
    for (let i = 0; i < rows.length; i++) await save(collection, rows[i])
    return { seeded: rows.length, skipped: false }
  }

  // ── File storage (Decisions 2, 3, 5, 9) ─────────────────────────────────────
  // Per-app FILE persistence, the twin of the record methods above. Same single
  // config/token source, same `X-App-Key` (+ Bearer) headers, same opaque-frame
  // discipline (reads the injected token, never the portal's browser storage). The SAME portal
  // access token authorizes file calls as records (the recorded POC tradeoff at the
  // top of this file; the refresh token is never injected). Two read paths encode
  // the intent split: `downloadFile` (SAS, save-to-disk; bytes bypass Node) vs
  // `fileObjectUrl` (same-origin `/content` proxy → blob: URL for inline render /
  // re-parse). The blob host is NEVER in the sandbox CSP — downloads ride the
  // `allow-downloads` navigation, inline render rides the already-admitted
  // `connect-src` portal origin via fetch('/content').

  /** Encode raw bytes to base64 in browser AND Node (btoa is global in both); chunked to bound the call stack. */
  function bytesToBase64(bytes) {
    var binary = ''
    var chunk = 0x8000
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }

  /** The X-App-Key (+ Bearer) headers for the byte-proxy fetch (which can't go through `call`, since it returns bytes not JSON). Same headers as `call` minus the JSON Content-Type. */
  function fileHeaders() {
    return baseHeaders()
  }

  /** Trigger a browser download via a transient `<a download>` (the only in-frame download primitive; rides the sandbox `allow-downloads`). */
  function triggerAnchorDownload(href, filename, revokeAfter) {
    const a = document.createElement('a')
    a.href = href
    a.download = filename || '' // cross-origin SAS uses its pinned content-disposition; same-origin uses this
    if (document.body) document.body.appendChild(a)
    a.click()
    if (document.body && a.parentNode) document.body.removeChild(a)
    if (revokeAfter && typeof URL !== 'undefined' && URL.revokeObjectURL) {
      setTimeout(function () {
        URL.revokeObjectURL(href)
      }, 0) // defer so the navigation can latch onto the blob: URL first
    }
  }

  /**
   * Upload one file. Accepts a DOM `File`/`Blob` (read to base64 here) OR a plain
   * `{ filename, contentType, base64 }`. POSTs to `…/files`; returns the stored
   * metadata `{ fileId, collection, filename, contentType, size, createdBy,
   * createdInDraft, createdAt, updatedAt }`. Type/size/quota are enforced server-side.
   */
  async function uploadFile(fileOrObj, opts) {
    opts = opts || {}
    let filename, contentType, base64
    if (fileOrObj && typeof fileOrObj.arrayBuffer === 'function') {
      const buf = await fileOrObj.arrayBuffer()
      base64 = bytesToBase64(new Uint8Array(buf))
      filename = fileOrObj.name || 'upload'
      contentType = fileOrObj.type || 'application/octet-stream'
    } else if (fileOrObj && typeof fileOrObj === 'object') {
      filename = fileOrObj.filename
      contentType = fileOrObj.contentType
      base64 = fileOrObj.base64
    } else {
      throw new Error('uploadFile needs a File/Blob or { filename, contentType, base64 }.')
    }
    const body = { filename: filename, contentType: contentType, base64: base64 }
    if (opts.collection) body.collection = opts.collection
    return call(filesUrl(), 'POST', body)
  }

  /** List ready files (newest-first). COLLECTION-FIRST, mirroring `list` so the model doesn't mis-call. `opts.limit` caps the page. Returns an array. */
  async function listFiles(collection, opts) {
    const params = []
    if (collection) params.push('collection=' + encodeURIComponent(collection))
    if (opts && opts.limit) params.push('limit=' + encodeURIComponent(opts.limit))
    const suffix = params.length ? '?' + params.join('&') : ''
    const out = await call(filesUrl(suffix), 'GET')
    return (out && out.files) || []
  }

  /** Read one file's metadata by id. Returns the metadata or null on 404. */
  async function getFile(fileId) {
    const out = await call(filesUrl('/' + encodeURIComponent(fileId)), 'GET')
    return (out && out.file) || null
  }

  /** Mint a short-lived download URL (SAS) for `<a download>`. Returns `{ url, expiresAt }`; throws (e.g. 501) if the provider can't sign. */
  function getDownloadUrl(fileId) {
    return call(filesUrl('/' + encodeURIComponent(fileId) + '/url'), 'GET')
  }

  /**
   * SAVE a file to disk. Mints a SAS via `/url` and clicks an `<a download>` whose
   * href is the cross-origin SAS URL. SECURITY: the SAS URL is validated to be
   * `https:` before it is assigned to the anchor — untrusted model code shares this
   * frame and could tamper a patched client into pointing the href at a
   * `javascript:`/`data:` URL. On a 501 (provider can't sign) OR a non-`https:` URL,
   * falls back to the same-origin `/content` proxy via `fileObjectUrl`.
   */
  async function downloadFile(fileId, filename) {
    let info = null
    try {
      info = await getDownloadUrl(fileId)
    } catch (e) {
      info = null // 501 / network → fall back to the /content proxy
    }
    const url = info && info.url
    if (typeof url === 'string' && url.indexOf('https://') === 0) {
      triggerAnchorDownload(url, filename, false)
      return { downloaded: true, via: 'sas' }
    }
    // Fallback: same-origin object URL (no SAS, or a tampered/non-https URL was returned).
    const objectUrl = await fileObjectUrl(fileId)
    triggerAnchorDownload(objectUrl, filename, true)
    return { downloaded: true, via: 'content' }
  }

  /**
   * RENDER / RE-PARSE a stored file inside the app. Fetches `…/files/:id/content`
   * (same-origin, carrying X-App-Key/Bearer — rides the already-admitted
   * `connect-src` portal origin), returns a `blob:` object-URL string for `<img src>`
   * or to re-parse the bytes. The caller revokes it (`URL.revokeObjectURL`) when done.
   */
  async function fileObjectUrl(fileId) {
    const res = await fetchImpl(filesUrl('/' + encodeURIComponent(fileId) + '/content'), {
      method: 'GET',
      headers: fileHeaders(),
    })
    if (res.status === 401) throw new Error('Please sign in to use this app.')
    if (!res.ok) throw new Error('Could not load the file (' + res.status + ').')
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  }

  /** Hard-delete a file (blob + metadata); returns `{ ok: true }`. */
  function removeFile(fileId) {
    return call(filesUrl('/' + encodeURIComponent(fileId)), 'DELETE')
  }

  /**
   * Sign in. In the DEPLOYED app the platform has already signed the user in (the
   * shared BIAL login on the app page) and injected the session, so this reuses that
   * session and never collects/forwards credentials — apps should not build a login
   * form at all (the generation prompt says so). The direct-fetch path below stays
   * only for the unit tests / any same-origin host; in a sandboxed app frame that
   * fetch is cross-origin-blocked, so we surface a clear "sign in from the portal"
   * message instead of a raw "Failed to fetch".
   */
  async function login(username, password) {
    const injected = typeof getUser === 'function' ? getUser() : null
    if (injected) {
      currentUserValue = injected
      return { user: injected }
    }
    let res
    try {
      const { baseUrl } = getConfig()
      res = await fetchImpl(baseUrl + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password }),
      })
    } catch (e) {
      throw new Error('Please sign in from the BIAL portal — this app does not handle sign-in itself.')
    }
    if (!res.ok) {
      throw new Error('Incorrect username or password.')
    }
    const data = await res.json()
    setToken(data.accessToken || null)
    currentUserValue = data.user || null
    return { user: currentUserValue }
  }

  var currentUserValue = null
  /**
   * The signed-in user: the platform-injected user if present (the normal deployed
   * case), else whoever an in-app `login()` set. Read-only — apps use it to greet the
   * user or stamp records, NOT to gate the screen behind a self-built login form.
   */
  function currentUser() {
    if (currentUserValue) return currentUserValue
    const injected = typeof getUser === 'function' ? getUser() : null
    return injected || null
  }

  return {
    save: save,
    list: list,
    query: query,
    distinct: distinct,
    get: get,
    update: update,
    remove: remove,
    seedFromUpload: seedFromUpload,
    uploadFile: uploadFile,
    listFiles: listFiles,
    getFile: getFile,
    getDownloadUrl: getDownloadUrl,
    downloadFile: downloadFile,
    fileObjectUrl: fileObjectUrl,
    removeFile: removeFile,
    login: login,
    currentUser: currentUser,
  }
}

/**
 * Browser bootstrap: serialize `createBIALData` and wire it to the postMessage-
 * injected globals (`window.__BIAL_CONFIG`, `window.__BIAL_TOKEN`). Inlined into
 * the preview + runner iframe shells. Reads config/token DYNAMICALLY at call time
 * (not at creation), so it works even though the app code may run before the
 * config/token postMessage arrives. NEVER references `localStorage`.
 */
export function bialDataClientScript() {
  return `
${createBIALData.toString()}
window.__BIAL_CONFIG = window.__BIAL_CONFIG || {};
window.__BIAL_TOKEN = window.__BIAL_TOKEN || null;
window.__BIAL_USER = window.__BIAL_USER || null;
window.BIALData = createBIALData({
  getConfig: function () { return window.__BIAL_CONFIG; },
  getToken: function () { return window.__BIAL_TOKEN; },
  setToken: function (t) { window.__BIAL_TOKEN = t; },
  getUser: function () { return window.__BIAL_USER; },
  fetchImpl: window.fetch.bind(window),
});`
}
