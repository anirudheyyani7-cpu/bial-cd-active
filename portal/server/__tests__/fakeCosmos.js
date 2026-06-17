/**
 * In-memory double for the Mongo `users` collection (Cosmos for MongoDB API).
 * Models the small surface users-repo depends on: findOne by `_id` (null on
 * miss, no throw), updateOne with a `$set` patch (matchedCount 0 on a miss, no
 * upsert), and replaceOne keyed by `_id` with upsert. Reused by repo, seed, and
 * route tests. Documents are keyed by `_id` (= username).
 */
export function makeFakeContainer(initialDocs = []) {
  const store = new Map(initialDocs.map((d) => [d._id, structuredClone(d)]))

  return {
    // expose for assertions in tests
    _store: store,
    _get: (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),

    async findOne(filter = {}) {
      const id = filter._id
      // Mongo findOne resolves with null (not a throw) on a miss.
      return store.has(id) ? structuredClone(store.get(id)) : null
    },

    async updateOne(filter = {}, update = {}) {
      const id = filter._id
      // No upsert: a miss matches nothing (matchedCount 0), it does NOT create.
      if (!store.has(id)) return { matchedCount: 0, modifiedCount: 0 }
      const doc = store.get(id)
      Object.assign(doc, update.$set ?? {})
      store.set(id, doc)
      return { matchedCount: 1, modifiedCount: 1 }
    },

    async replaceOne(filter = {}, replacement = {}, opts = {}) {
      const id = filter._id
      const existed = store.has(id)
      store.set(id, structuredClone(replacement))
      return {
        matchedCount: existed ? 1 : 0,
        modifiedCount: existed ? 1 : 0,
        upsertedCount: !existed && opts.upsert ? 1 : 0,
      }
    },
  }
}
