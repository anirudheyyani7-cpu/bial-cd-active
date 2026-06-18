/**
 * In-memory double for the Mongo `users` collection (Cosmos for MongoDB API).
 * Models the small surface users-repo depends on: findOne by `_id` (null on
 * miss, no throw), updateOne with `$set`/`$unset` patches (matchedCount 0 on a
 * miss, no upsert), replaceOne keyed by `_id` with upsert, and find() returning
 * a toArray()-able cursor with field-exclusion projection. Reused by repo, seed,
 * and route tests. Documents are keyed by `_id` (= username).
 *
 * `$set`/`$unset` keys may be dotted paths (e.g. `limits.dailyTokenLimit`),
 * which Mongo treats as nested-field writes — the helpers below mirror that so
 * `limits.*` overrides land as a real nested object, not a literal dotted key.
 */

/** Set a possibly-dotted path on `doc` (creating intermediate objects). */
function setPath(doc, path, value) {
  const keys = path.split('.')
  let node = doc
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {}
    node = node[keys[i]]
  }
  node[keys[keys.length - 1]] = value
}

/** Unset a possibly-dotted path on `doc` (no-op if the parent is absent). */
function unsetPath(doc, path) {
  const keys = path.split('.')
  let node = doc
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) return
    node = node[keys[i]]
  }
  delete node[keys[keys.length - 1]]
}

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
      for (const [path, value] of Object.entries(update.$set ?? {})) setPath(doc, path, value)
      for (const path of Object.keys(update.$unset ?? {})) unsetPath(doc, path)
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

    // Minimal cursor: returns all docs (filter is only ever {} here), applying
    // a field-EXCLUSION projection ({ field: 0 }) — the only form listUsers uses.
    find(_filter = {}, opts = {}) {
      const excluded = Object.entries(opts.projection ?? {})
        .filter(([, v]) => v === 0)
        .map(([k]) => k)
      return {
        async toArray() {
          return [...store.values()].map((d) => {
            const clone = structuredClone(d)
            for (const k of excluded) delete clone[k]
            return clone
          })
        },
      }
    },
  }
}
