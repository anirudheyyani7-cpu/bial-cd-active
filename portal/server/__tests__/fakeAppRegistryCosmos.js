/**
 * In-memory double for the Mongo `app_registry` collection (Cosmos for MongoDB
 * API). Documents are keyed by `_id` = appId. Models exactly the slice the
 * app-registry-repo uses:
 *   - findOne({_id})/findOne({appKey})            — point reads.
 *   - findOneAndUpdate({_id}, …, {upsert, returnDocument:'after'}) — ensureDraft.
 *   - findOneAndUpdate({_id, dataCount:{$lte}, dataBytes:{$lte}}, {$inc}, …) — the
 *     ATOMIC conditional quota reserve. Its read-check-write body has NO internal
 *     await, so concurrent callers serialize on the microtask queue just like
 *     Mongo serializes per-document (what makes the quota race meaningful).
 *   - updateOne({_id, status:{$in}}, {$set}) — the atomic status-machine guard.
 *   - updateOne({_id}, {$set:{ 'code.source': … }}) — dotted-path snapshot writes.
 *   - find({status?}).sort().limit().toArray() — admin list.
 *   - deleteOne({_id}) — admin delete.
 *
 * Mirrors the dedicated-fake precedent of fakeConversationsCosmos.js (dotted $set,
 * upsert insert) and fakeAttachmentUsageCosmos.js ($lte conditional reserve).
 */

/** Match one field value against an equality value OR an operator condition. */
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
        case '$in':
          return Array.isArray(v) && v.includes(docVal)
        case '$ne':
          return docVal !== v
        case '$exists':
          return v ? docVal !== undefined : docVal === undefined
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

/** Apply a $set value to a possibly-dotted path (e.g. 'code.source'). */
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

export function makeFakeAppRegistryContainer(initialDocs = []) {
  const store = new Map(initialDocs.map((d) => [d._id, structuredClone(d)]))

  return {
    _store: store,
    _get: (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),

    async findOne(filter = {}) {
      const hit = [...store.values()].find((d) => matchesFilter(d, filter))
      return hit ? structuredClone(hit) : null
    },

    // ATOMIC: read-check-write with no internal await (see header). Supports
    // upsert insert (ensureDraft) and conditional reserve (incData).
    async findOneAndUpdate(filter = {}, update = {}, opts = {}) {
      const existing = [...store.values()].find((d) => matchesFilter(d, filter))
      if (existing) {
        const doc = structuredClone(existing)
        applyUpdate(doc, update, false)
        store.set(doc._id, doc)
        return opts.returnDocument === 'after' ? structuredClone(doc) : structuredClone(existing)
      }
      if (!opts.upsert) return null
      // Upsert insert: seed equality fields from the filter (skip operator-valued
      // conditions like {$lte}), then apply $setOnInsert/$inc/$set.
      const doc = {}
      for (const [k, v] of Object.entries(filter)) {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) doc[k] = v
      }
      applyUpdate(doc, update, true)
      store.set(doc._id, doc)
      return opts.returnDocument === 'after' ? structuredClone(doc) : null
    },

    async updateOne(filter = {}, update = {}, opts = {}) {
      const existing = [...store.values()].find((d) => matchesFilter(d, filter))
      if (existing) {
        const doc = structuredClone(existing)
        applyUpdate(doc, update, false)
        store.set(doc._id, doc)
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
      }
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
      const doc = {}
      for (const [k, v] of Object.entries(filter)) {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) doc[k] = v
      }
      applyUpdate(doc, update, true)
      store.set(doc._id, doc)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    },

    find(filter = {}) {
      let docs = [...store.values()].filter((d) => matchesFilter(d, filter)).map((d) => structuredClone(d))
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

    async deleteOne(filter = {}) {
      const hit = [...store.values()].find((d) => matchesFilter(d, filter))
      if (!hit) return { deletedCount: 0 }
      store.delete(hit._id)
      return { deletedCount: 1 }
    },
  }
}
