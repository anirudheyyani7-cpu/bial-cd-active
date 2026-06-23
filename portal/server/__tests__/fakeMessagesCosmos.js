/**
 * In-memory double for the Mongo `messages` collection (Cosmos for MongoDB API).
 * Models the slice the repo uses: insertOne (duplicate `_id` → E11000, so the
 * idempotent-retry path is exercised), a multi-key `find().sort().limit().toArray()`
 * chain (sort {seq}) honoring the full `{ conversationId, username }`
 * filter, and deleteMany. Documents are keyed by `_id` (a client-minted uuid).
 *
 * Mirrors the dedicated-fake precedent of fakeFeedbackCosmos.js.
 */

/** Every equality field in `filter` must match (flat filters only — all we use). */
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => doc[k] === v)
}

export function makeFakeMessagesContainer(initialDocs = []) {
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
          const entries = Object.entries(spec)
          docs.sort((a, b) => {
            for (const [field, dir] of entries) {
              if (a[field] < b[field]) return dir < 0 ? 1 : -1
              if (a[field] > b[field]) return dir < 0 ? -1 : 1
            }
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

    async deleteMany(filter = {}) {
      let deletedCount = 0
      for (const [id, d] of [...store.entries()]) {
        if (matches(d, filter)) {
          store.delete(id)
          deletedCount += 1
        }
      }
      return { deletedCount }
    },
  }
}
