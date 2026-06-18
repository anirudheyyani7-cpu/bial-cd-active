/**
 * In-memory double for the Mongo `feedback` collection (Cosmos for MongoDB API).
 * Separate from the shared `fakeCosmos.js` because feedback needs `insertOne` and
 * a `find().sort().limit().toArray()` chain plus `countDocuments()`, none of which
 * the users fake models (and 11+ tests depend on that fake's exact semantics).
 * Mirrors the dedicated-fake precedent set by `fakeUsageCosmos.js`. Documents are
 * keyed by `_id` (a caller-generated random base64url string).
 */
export function makeFakeFeedbackContainer(initialDocs = []) {
  const store = new Map(initialDocs.map((d) => [d._id, structuredClone(d)]))

  return {
    // expose for assertions in tests
    _store: store,
    _get: (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),

    async insertOne(doc) {
      // Mongo rejects a duplicate _id; feedback _ids are random so a collision is
      // a real bug — surface it the same way the driver would rather than silently
      // overwriting an existing row.
      if (store.has(doc._id)) {
        const err = new Error('E11000 duplicate key error')
        err.code = 11000
        throw err
      }
      store.set(doc._id, structuredClone(doc))
      return { acknowledged: true, insertedId: doc._id }
    },

    // Minimal cursor: the repo only ever calls find({}).sort().limit().toArray().
    // Each stage mutates the working slice and returns the same chainable cursor.
    find(_filter = {}) {
      let docs = [...store.values()].map((d) => structuredClone(d))
      const cursor = {
        sort(spec = {}) {
          const [[field, dir] = ['createdAt', -1]] = Object.entries(spec)
          docs.sort((a, b) => {
            if (a[field] < b[field]) return dir < 0 ? 1 : -1
            if (a[field] > b[field]) return dir < 0 ? -1 : 1
            return 0
          })
          return cursor
        },
        limit(n) {
          docs = docs.slice(0, n)
          return cursor
        },
        async toArray() {
          return docs
        },
      }
      return cursor
    },

    async countDocuments(_filter = {}) {
      return store.size
    },
  }
}
