/**
 * In-memory double for the Mongo `audit_logs` collection (Cosmos for MongoDB
 * API). Append-only: the repo only ever calls insertOne and
 * find({appId}).sort({at:-1}).limit().toArray(). Documents are keyed by a
 * caller-generated random `_id`. Mirrors fakeFeedbackCosmos.js, with an appId
 * filter on the list (events are partitioned per app).
 */
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => doc[k] === v)
}

export function makeFakeAuditContainer(initialDocs = []) {
  const store = new Map(initialDocs.map((d) => [d._id, structuredClone(d)]))

  return {
    _store: store,
    _get: (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),

    async insertOne(doc) {
      if (store.has(doc._id)) {
        const err = new Error('E11000 duplicate key error')
        err.code = 11000
        throw err
      }
      store.set(doc._id, structuredClone(doc))
      return { acknowledged: true, insertedId: doc._id }
    },

    find(filter = {}) {
      let docs = [...store.values()].filter((d) => matches(d, filter)).map((d) => structuredClone(d))
      const cursor = {
        sort(spec = {}) {
          const [[field, dir] = ['at', -1]] = Object.entries(spec)
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
  }
}
