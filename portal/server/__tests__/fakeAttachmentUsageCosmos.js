/**
 * In-memory double for the Mongo `attachment_usage` collection (Cosmos for
 * MongoDB API). One doc per user (`_id` = username) holding the running byte
 * `total`. Models exactly the slice the attachments-repo uses:
 *   - updateOne({_id}, {$setOnInsert}, {upsert}) — ensure the counter exists.
 *   - findOneAndUpdate({_id, total:{$lte:N}}, {$inc}, {returnDocument:'after'}) —
 *     the ATOMIC conditional reserve. Critically, its read-check-write body has no
 *     internal await, so concurrent callers serialize on the microtask queue just
 *     like Mongo serializes per-document — this is what makes the quota race test
 *     meaningful (a non-atomic read-then-write would let two near-cap reserves
 *     both pass).
 *   - findOne({_id}) — total read.
 */

/** Match a single field value against an equality value OR a {$lte}/{$gte}/… cond. */
function matchOne(docVal, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$lte':
          return docVal <= v
        case '$gte':
          return docVal >= v
        case '$lt':
          return docVal < v
        case '$gt':
          return docVal > v
        default:
          return false
      }
    })
  }
  return docVal === cond
}

function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => matchOne(doc[k], cond))
}

export function makeFakeAttachmentUsageContainer(initialDocs = []) {
  const store = new Map(initialDocs.map((d) => [d._id, structuredClone(d)]))

  return {
    _store: store,
    _get: (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),

    async findOne(filter = {}) {
      const hit = [...store.values()].find((d) => matchesFilter(d, filter))
      return hit ? structuredClone(hit) : null
    },

    async updateOne(filter = {}, update = {}, opts = {}) {
      const existing = [...store.values()].find((d) => matchesFilter(d, filter))
      if (existing) {
        const doc = structuredClone(existing)
        for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + v
        Object.assign(doc, update.$set ?? {})
        store.set(doc._id, doc)
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
      }
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
      const doc = {}
      for (const [k, v] of Object.entries(filter)) if (typeof v !== 'object') doc[k] = v
      Object.assign(doc, update.$setOnInsert ?? {})
      for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + v
      Object.assign(doc, update.$set ?? {})
      store.set(doc._id, doc)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    },

    // ATOMIC: read-check-write with no internal await (see header).
    async findOneAndUpdate(filter = {}, update = {}, opts = {}) {
      const hit = [...store.values()].find((d) => matchesFilter(d, filter))
      if (!hit) return null
      const updated = structuredClone(hit)
      for (const [k, v] of Object.entries(update.$inc ?? {})) updated[k] = (updated[k] ?? 0) + v
      Object.assign(updated, update.$set ?? {})
      store.set(updated._id, updated)
      return opts.returnDocument === 'after' ? structuredClone(updated) : structuredClone(hit)
    },
  }
}
