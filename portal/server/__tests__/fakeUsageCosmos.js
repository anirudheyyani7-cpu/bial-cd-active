/**
 * In-memory double for the Mongo `daily_token_usage` collection (Cosmos for
 * MongoDB API). Separate from the shared `fakeCosmos.js` because usage needs
 * `$inc` + `$setOnInsert` + upsert semantics that the users fake deliberately
 * does NOT model (11+ tests depend on its `$set`-only / no-upsert behaviour).
 * Documents are keyed by `_id` (= `${username}:${IST-date}`).
 */
export function makeFakeUsageContainer(initialDocs = []) {
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

    async updateOne(filter = {}, update = {}, opts = {}) {
      const id = filter._id
      const existed = store.has(id)
      // A miss without upsert matches nothing and creates nothing (no crash).
      if (!existed && !opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }

      const doc = existed ? store.get(id) : { _id: id }
      if (!existed) Object.assign(doc, update.$setOnInsert ?? {}) // $setOnInsert applies on insert only
      for (const [k, v] of Object.entries(update.$inc ?? {})) {
        doc[k] = (doc[k] ?? 0) + v
      }
      Object.assign(doc, update.$set ?? {})
      store.set(id, doc)

      return {
        matchedCount: existed ? 1 : 0,
        modifiedCount: 1,
        upsertedCount: !existed && opts.upsert ? 1 : 0,
      }
    },
  }
}
