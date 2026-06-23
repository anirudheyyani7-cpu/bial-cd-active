/**
 * In-memory double for the Mongo `app_files` collection (Cosmos for MongoDB API).
 * Documents are keyed by `_id` (the server-minted fileId) and partitioned by `appId`.
 * Models exactly the slice app-files-repo uses — composite-owner filters plus the
 * `status` gate and the stale-`pending` `createdAt: { $lt }` sweep:
 *   - insertOne(doc)                                  — reject duplicate _id.
 *   - findOne({_id, appId, status?})                  — composite point read.
 *   - find({appId, collection?, status?, createdAt?}).sort().limit().toArray() — list/sweep.
 *   - updateOne({_id, appId}, {$set})                 — markReady.
 *   - deleteOne({_id, appId})                         — hard delete.
 *   - deleteMany({appId, createdInDraft?|status,createdAt})  — purge / stale-pending sweep.
 *
 * Mirrors fakeDataRecordsCosmos.js; the filter matcher additionally supports the
 * comparison operators ($lt/$lte/$gt/$gte) the recompute sweep relies on.
 */

function getPath(obj, path) {
  return path.split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), obj)
}

function matchCond(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$lt':
          return actual !== undefined && actual < v
        case '$lte':
          return actual !== undefined && actual <= v
        case '$gt':
          return actual !== undefined && actual > v
        case '$gte':
          return actual !== undefined && actual >= v
        case '$exists':
          return v ? actual !== undefined : actual === undefined
        case '$regex': {
          if (actual === undefined || actual === null) return false
          const re = v instanceof RegExp ? v : new RegExp(v, cond.$options || '')
          return re.test(String(actual))
        }
        default:
          return false
      }
    })
  }
  return actual === cond
}

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => matchCond(getPath(doc, k), v))
}

function setPath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

export function makeFakeAppFilesContainer(initialDocs = []) {
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
          const entries = Object.entries(spec)
          docs.sort((a, b) => {
            for (const [field, dir] of entries) {
              const av = getPath(a, field)
              const bv = getPath(b, field)
              if (av < bv) return dir < 0 ? 1 : -1
              if (av > bv) return dir < 0 ? -1 : 1
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
