/**
 * In-memory double for the Mongo `conversations` collection (Cosmos for MongoDB
 * API). Separate from the shared fakes because conversations need FULL-filter
 * matching (`{ _id, username }`, `{ username, kind }`) plus a $set/$setOnInsert
 * upsert that rejects a cross-user `_id` collision with a duplicate-key error —
 * the exact semantics that close the write-IDOR. Documents are keyed by `_id`
 * (a client-minted uuid).
 *
 * Mirrors the dedicated-fake precedent of fakeUsageCosmos.js / fakeFeedbackCosmos.js.
 */

/** Every equality field in `filter` must match (flat filters only — all we use). */
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => doc[k] === v)
}

/** Apply a $set value to a possibly-dotted path (e.g. 'code.current'). */
function setPath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

function applyUpdate(doc, update, isInsert) {
  if (isInsert) Object.assign(doc, update.$setOnInsert ?? {})
  for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + v
  for (const [path, v] of Object.entries(update.$set ?? {})) setPath(doc, path, v)
}

export function makeFakeConversationsContainer(initialDocs = []) {
  const store = new Map(initialDocs.map((d) => [d._id, structuredClone(d)]))

  return {
    _store: store,
    _get: (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),

    async findOne(filter = {}) {
      const hit = [...store.values()].find((d) => matches(d, filter))
      return hit ? structuredClone(hit) : null
    },

    async updateOne(filter = {}, update = {}, opts = {}) {
      const existing = [...store.values()].find((d) => matches(d, filter))
      if (existing) {
        const doc = structuredClone(existing)
        applyUpdate(doc, update, false) // $setOnInsert does NOT apply on update
        store.set(doc._id, doc)
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
      }
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
      // Upsert insert. The new _id comes from the filter (or $setOnInsert). If a
      // doc with that _id already exists (it didn't match the full filter, so it
      // belongs to a DIFFERENT owner) the unique _id index rejects the insert —
      // exactly the write-IDOR closure the route relies on.
      const _id = filter._id ?? update.$setOnInsert?._id
      if (_id !== undefined && store.has(_id)) {
        const err = new Error('E11000 duplicate key error')
        err.code = 11000
        throw err
      }
      const doc = {}
      for (const [k, v] of Object.entries(filter)) doc[k] = v // equality fields seed the doc
      applyUpdate(doc, update, true)
      store.set(doc._id, doc)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    },

    find(filter = {}) {
      let docs = [...store.values()].filter((d) => matches(d, filter)).map((d) => structuredClone(d))
      const cursor = {
        sort(spec = {}) {
          const [[field, dir] = ['updatedAt', -1]] = Object.entries(spec)
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

    async deleteOne(filter = {}) {
      const hit = [...store.values()].find((d) => matches(d, filter))
      if (!hit) return { deletedCount: 0 }
      store.delete(hit._id)
      return { deletedCount: 1 }
    },
  }
}
