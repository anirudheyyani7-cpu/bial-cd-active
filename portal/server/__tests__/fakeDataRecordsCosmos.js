/**
 * In-memory double for the Mongo `data_records` collection (Cosmos for MongoDB
 * API). Documents are keyed by `_id` (a server-minted uuid) and partitioned by
 * `appId`. Models exactly the slice the data-records-repo uses — all filters are
 * flat equality (the tenant choke-point only ever uses `{appId}` and composite
 * `{_id, appId}`):
 *   - insertOne(doc)                              — random uuid, reject duplicate.
 *   - findOne({_id, appId})                       — composite point read.
 *   - find({appId, collection?}).sort().limit().toArray() — per-tenant list.
 *   - updateOne({_id, appId}, {$set})             — patch.
 *   - deleteOne({_id, appId})                     — hard delete.
 *   - deleteMany({appId, createdInDraft?})        — admin clear-data.
 *
 * Mirrors fakeConversationsCosmos.js (composite-owner filter, dotted $set).
 */

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => doc[k] === v)
}

/** Apply a $set value to a possibly-dotted path (e.g. 'data.foo'). */
function setPath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

export function makeFakeDataRecordsContainer(initialDocs = []) {
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

    async findOne(filter = {}) {
      const hit = [...store.values()].find((d) => matches(d, filter))
      return hit ? structuredClone(hit) : null
    },

    find(filter = {}) {
      let docs = [...store.values()].filter((d) => matches(d, filter)).map((d) => structuredClone(d))
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

    async updateOne(filter = {}, update = {}) {
      const existing = [...store.values()].find((d) => matches(d, filter))
      if (!existing) return { matchedCount: 0, modifiedCount: 0 }
      const doc = structuredClone(existing)
      for (const [path, v] of Object.entries(update.$set ?? {})) setPath(doc, path, v)
      store.set(doc._id, doc)
      return { matchedCount: 1, modifiedCount: 1 }
    },

    async deleteOne(filter = {}) {
      const hit = [...store.values()].find((d) => matches(d, filter))
      if (!hit) return { deletedCount: 0 }
      store.delete(hit._id)
      return { deletedCount: 1 }
    },

    async deleteMany(filter = {}) {
      let deletedCount = 0
      for (const d of [...store.values()]) {
        if (matches(d, filter)) {
          store.delete(d._id)
          deletedCount += 1
        }
      }
      return { deletedCount }
    },
  }
}
