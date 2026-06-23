/**
 * In-memory double for the ObjectStore seam (object-store.js). A Map keyed by the
 * object key, implementing the same put/get/delete/exists interface the
 * attachments-repo depends on. `get` on a missing key throws a NoSuchKey-shaped
 * error (like the real S3 client) so the route's 404 path is exercised.
 */
export function makeFakeObjectStore(initial = {}) {
  const store = new Map(Object.entries(initial))

  return {
    _store: store,

    async put(key, body, contentType) {
      store.set(key, { body: Buffer.from(body), contentType })
    },

    async get(key) {
      if (!store.has(key)) {
        const err = new Error('NoSuchKey')
        err.name = 'NoSuchKey'
        err.$metadata = { httpStatusCode: 404 }
        throw err
      }
      return Buffer.from(store.get(key).body)
    },

    async delete(key) {
      store.delete(key)
    },

    async exists(key) {
      return store.has(key)
    },

    /**
     * Deterministic stub for the download-URL seam: an https URL embedding the key
     * + a fake signature + the TTL + a content-disposition. https-prefixed so the
     * BIALData downloadFile https-scheme guard accepts it; no network involved.
     */
    async getDownloadUrl(key, { expiresInSeconds = 120, filename, contentType } = {}) {
      const params = new URLSearchParams({
        sig: 'fake-signature',
        se: String(expiresInSeconds),
        rscd: `attachment; filename="${filename || 'download'}"`,
      })
      if (contentType) params.set('rsct', contentType)
      return `https://fake-objectstore.local/${key}?${params.toString()}`
    },
  }
}
