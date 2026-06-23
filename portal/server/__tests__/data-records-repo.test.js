import { describe, it, expect } from 'vitest'
import {
  createDataRecordsRepo,
  sanitizeData,
  sanitizeCollection,
  sanitizeFieldName,
  resolveSortPath,
  buildDataFilter,
  buildSearchBlob,
  escapeRegex,
  RecordQuotaError,
} from '../data-records-repo.js'
import { createAppRegistryRepo, APP_RECORD_COUNT_CAP } from '../app-registry-repo.js'
import { makeFakeDataRecordsContainer } from './fakeDataRecordsCosmos.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'

const A = 'app-A'
const B = 'app-B'

/**
 * Wire a data-records repo over the REAL registry repo (its fake container), so
 * the atomic quota path is exercised end-to-end. `registrySeed` lets a test pin a
 * counter near the cap.
 */
function setup({ records = [], registrySeed } = {}) {
  const registryDocs = registrySeed ?? [
    { _id: A, status: 'draft', dataCount: 0, dataBytes: 0 },
    { _id: B, status: 'draft', dataCount: 0, dataBytes: 0 },
  ]
  const registryContainer = makeFakeAppRegistryContainer(registryDocs)
  const registryRepo = createAppRegistryRepo(registryContainer)
  const dataContainer = makeFakeDataRecordsContainer(records)
  const repo = createDataRecordsRepo(dataContainer, registryRepo)
  return { repo, registryRepo, registryContainer, dataContainer }
}

describe('data-records-repo — insert / get / list (server owns identity)', () => {
  it('insert then get/list returns the record with data intact; reserved fields server-set', async () => {
    const { repo, registryContainer } = setup()
    const rec = await repo.insert({ appId: A, collection: 'default', data: { title: 'Inspect gate 4' }, createdBy: 'alice', createdInDraft: true })
    expect(rec._id).toBeTypeOf('string')
    expect(rec.appId).toBe(A)
    expect(rec.collection).toBe('default')
    expect(rec.data).toEqual({ title: 'Inspect gate 4' })
    expect(rec.createdBy).toBe('alice')
    expect(rec.createdInDraft).toBe(true)
    expect(rec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(rec.bytes).toBeGreaterThan(0)

    expect((await repo.get(A, rec._id)).data).toEqual({ title: 'Inspect gate 4' })
    const list = await repo.list(A, {})
    expect(list).toHaveLength(1)
    // quota counters moved by exactly the reserved amount
    expect(registryContainer._get(A).dataCount).toBe(1)
    expect(registryContainer._get(A).dataBytes).toBe(rec.bytes)
  })

  it('createdBy defaults to null (anonymous app) and createdInDraft to false', async () => {
    const { repo } = setup()
    const rec = await repo.insert({ appId: A, collection: 'default', data: { x: 1 } })
    expect(rec.createdBy).toBeNull()
    expect(rec.createdInDraft).toBe(false)
  })

  it('list is newest-first (by createdAt) and filters by collection', async () => {
    // Explicit distinct timestamps so the createdAt-desc ordering is unambiguous
    // (same-ms inserts tie on the ISO-ms key, exactly as real Mongo would).
    const { repo } = setup({
      records: [
        { _id: 'r1', appId: A, collection: 'equipment', data: { n: 1 }, bytes: 5, createdAt: '2026-01-01T00:00:01.000Z' },
        { _id: 'r2', appId: A, collection: 'inspections', data: { n: 2 }, bytes: 5, createdAt: '2026-01-01T00:00:02.000Z' },
        { _id: 'r3', appId: A, collection: 'inspections', data: { n: 3 }, bytes: 5, createdAt: '2026-01-01T00:00:03.000Z' },
      ],
    })
    const inspections = await repo.list(A, { collection: 'inspections' })
    expect(inspections.map((r) => r.data.n)).toEqual([3, 2]) // newest-first
    expect(await repo.list(A, {})).toHaveLength(3)
  })
})

describe('data-records-repo — tenant isolation (composite {_id, appId})', () => {
  it('app B can never get/update/del app A’s record, and never appears in B’s list', async () => {
    const { repo } = setup()
    const recA = await repo.insert({ appId: A, collection: 'default', data: { secret: 'A-only' } })

    // get scoped to B returns nothing for A's id
    expect(await repo.get(B, recA._id)).toBeNull()
    // list for B is empty (A's row is partitioned away)
    expect(await repo.list(B, {})).toHaveLength(0)
    // update scoped to B cannot mutate A's row
    expect(await repo.update(B, recA._id, { secret: 'tampered' })).toBeNull()
    expect((await repo.get(A, recA._id)).data.secret).toBe('A-only') // untouched
    // del scoped to B cannot remove A's row
    expect((await repo.del(B, recA._id)).deleted).toBe(false)
    expect(await repo.get(A, recA._id)).not.toBeNull() // still there
  })
})

describe('data-records-repo — update (PATCH merge + byte reconciliation)', () => {
  it('shallow-merges data, preserves untouched keys, and updates the byte counter', async () => {
    const { repo, registryContainer } = setup()
    const rec = await repo.insert({ appId: A, collection: 'default', data: { status: 'open', notes: 'keep me' } })
    const beforeBytes = registryContainer._get(A).dataBytes
    const updated = await repo.update(A, rec._id, { status: 'closed' })
    expect(updated.data).toEqual({ status: 'closed', notes: 'keep me' }) // merge, not replace
    // counter reflects the new byte size delta (no drift)
    expect(registryContainer._get(A).dataBytes).toBe(updated.bytes)
    expect(registryContainer._get(A).dataBytes).not.toBe(beforeBytes)
  })

  it('returns null for a record in another tenant (no cross-tenant write)', async () => {
    const { repo } = setup()
    const rec = await repo.insert({ appId: A, collection: 'default', data: { a: 1 } })
    expect(await repo.update(B, rec._id, { a: 2 })).toBeNull()
  })

  it('rolls back the reserved byte delta + returns null when the record vanished concurrently (no drift, no false success)', async () => {
    const { repo, registryContainer, dataContainer } = setup()
    const rec = await repo.insert({ appId: A, collection: 'default', data: { a: 1 } })
    const bytesBefore = registryContainer._get(A).dataBytes
    // Simulate a concurrent delete landing between the read and the write: the
    // composite-filter updateOne matches nothing.
    dataContainer.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0 })
    const out = await repo.update(A, rec._id, { a: 1, padding: 'x'.repeat(200) }) // delta > 0
    expect(out).toBeNull() // truthful — the route will 404, not fabricate a 200
    expect(registryContainer._get(A).dataBytes).toBe(bytesBefore) // reserve rolled back, no drift
  })

  it('rolls back the reserved byte delta when the update write throws', async () => {
    const { repo, registryContainer, dataContainer } = setup()
    const rec = await repo.insert({ appId: A, collection: 'default', data: { a: 1 } })
    const bytesBefore = registryContainer._get(A).dataBytes
    dataContainer.updateOne = async () => {
      throw new Error('write blew up')
    }
    await expect(repo.update(A, rec._id, { a: 1, padding: 'x'.repeat(200) })).rejects.toThrow('write blew up')
    expect(registryContainer._get(A).dataBytes).toBe(bytesBefore) // no upward drift
  })
})

describe('data-records-repo — hard delete + quota release', () => {
  it('del hard-removes the record and decrements the counter by 1/−bytes', async () => {
    const { repo, registryContainer } = setup()
    const rec = await repo.insert({ appId: A, collection: 'default', data: { a: 1 } })
    expect(registryContainer._get(A).dataCount).toBe(1)
    const res = await repo.del(A, rec._id)
    expect(res.deleted).toBe(true)
    expect(await repo.get(A, rec._id)).toBeNull() // gone
    expect(await repo.list(A, {})).toHaveLength(0)
    expect(registryContainer._get(A).dataCount).toBe(0) // released
    expect(registryContainer._get(A).dataBytes).toBe(0)
  })

  it('create/delete churn does not exhaust the quota (symmetric counter)', async () => {
    // Seed the registry one slot below the cap so churn would exhaust it if del
    // failed to release.
    const { repo, registryContainer } = setup({
      registrySeed: [{ _id: A, status: 'draft', dataCount: APP_RECORD_COUNT_CAP - 1, dataBytes: 0 }],
    })
    for (let i = 0; i < 5; i += 1) {
      const rec = await repo.insert({ appId: A, collection: 'default', data: { i } })
      await repo.del(A, rec._id)
    }
    // Back to one-below-cap after churn, and a final insert still fits.
    expect(registryContainer._get(A).dataCount).toBe(APP_RECORD_COUNT_CAP - 1)
    const last = await repo.insert({ appId: A, collection: 'default', data: { last: true } })
    expect(last._id).toBeTypeOf('string')
  })
})

describe('data-records-repo — quota cap (atomic, no drift)', () => {
  it('insert past the per-app quota throws RecordQuotaError and leaves the counter unchanged', async () => {
    const { repo, registryContainer, dataContainer } = setup({
      registrySeed: [{ _id: A, status: 'draft', dataCount: APP_RECORD_COUNT_CAP, dataBytes: 0 }],
    })
    await expect(repo.insert({ appId: A, collection: 'default', data: { a: 1 } })).rejects.toBeInstanceOf(RecordQuotaError)
    expect(registryContainer._get(A).dataCount).toBe(APP_RECORD_COUNT_CAP) // unchanged
    expect(dataContainer._store.size).toBe(0) // nothing stored
  })

  it('compensates the reserve back when the insert itself fails (no upward drift)', async () => {
    const { repo, registryContainer, dataContainer } = setup()
    dataContainer.insertOne = async () => {
      throw new Error('insert blew up')
    }
    await expect(repo.insert({ appId: A, collection: 'default', data: { a: 1 } })).rejects.toThrow('insert blew up')
    expect(registryContainer._get(A).dataCount).toBe(0) // reserve rolled back
    expect(registryContainer._get(A).dataBytes).toBe(0)
  })
})

describe('data-records-repo — purgeByApp (admin clear-data)', () => {
  it('createdInDraftOnly removes only draft rows and adjusts counters; full purge zeroes them', async () => {
    const { repo, registryContainer } = setup()
    await repo.insert({ appId: A, collection: 'default', data: { d: 1 }, createdInDraft: true })
    await repo.insert({ appId: A, collection: 'default', data: { d: 2 }, createdInDraft: true })
    const live = await repo.insert({ appId: A, collection: 'default', data: { live: 1 }, createdInDraft: false })

    const draftPurge = await repo.purgeByApp(A, { createdInDraftOnly: true })
    expect(draftPurge.removed).toBe(2)
    const remaining = await repo.list(A, {})
    expect(remaining.map((r) => r._id)).toEqual([live._id]) // live row survives
    expect(registryContainer._get(A).dataCount).toBe(1) // adjusted by 2

    const fullPurge = await repo.purgeByApp(A, {})
    expect(fullPurge.removed).toBe(1)
    expect(await repo.list(A, {})).toHaveLength(0)
    expect(registryContainer._get(A).dataCount).toBe(0) // zeroed
    expect(registryContainer._get(A).dataBytes).toBe(0)
  })
})

describe('data-records-repo — sanitizeData / sanitizeCollection', () => {
  it('sanitizeData rejects $/. keys (incl. nested) and strips reserved keys', async () => {
    expect(sanitizeData({ $where: 'evil' }).ok).toBe(false)
    expect(sanitizeData({ 'a.b': 1 }).ok).toBe(false)
    expect(sanitizeData({ nested: { $gt: 1 } }).ok).toBe(false)
    expect(sanitizeData('nope').ok).toBe(false)
    expect(sanitizeData([1, 2]).ok).toBe(false)
    const cleaned = sanitizeData({ _id: 'spoof', appId: 'other', createdBy: 'admin', title: 'ok', count: 3 })
    expect(cleaned.ok).toBe(true)
    expect(cleaned.value).toEqual({ title: 'ok', count: 3 }) // reserved stripped
  })

  it('sanitizeData rejects over-deep nesting', async () => {
    let deep = { v: 1 }
    for (let i = 0; i < 10; i += 1) deep = { nested: deep }
    expect(sanitizeData(deep).ok).toBe(false)
  })

  it('sanitizeCollection defaults absent → "default" and rejects bad names', async () => {
    expect(sanitizeCollection(undefined)).toEqual({ ok: true, value: 'default' })
    expect(sanitizeCollection('inspections_2024')).toEqual({ ok: true, value: 'inspections_2024' })
    expect(sanitizeCollection('bad/name').ok).toBe(false) // path separator
    expect(sanitizeCollection('x'.repeat(65)).ok).toBe(false) // over 64 chars
    expect(sanitizeCollection(42).ok).toBe(false) // non-string
  })
})

describe('data-records-repo — throttle resilience', () => {
  it('retries a Cosmos throttle (16500) on insert then succeeds; a non-throttle propagates', async () => {
    const { repo, dataContainer } = setup()
    const realInsert = dataContainer.insertOne.bind(dataContainer)
    let calls = 0
    dataContainer.insertOne = async (doc) => {
      calls += 1
      if (calls === 1) {
        const err = new Error('TooManyRequests')
        err.code = 16500
        throw err
      }
      return realInsert(doc)
    }
    const rec = await repo.insert({ appId: A, collection: 'default', data: { a: 1 } })
    expect(rec._id).toBeTypeOf('string')
    expect(calls).toBe(2) // retried once

    const { repo: repo2, dataContainer: dc2 } = setup()
    dc2.insertOne = async () => {
      const err = new Error('boom')
      err.code = 500
      throw err
    }
    await expect(repo2.insert({ appId: A, collection: 'default', data: { a: 1 } })).rejects.toThrow('boom')
  })
})

describe('data-records-repo — _search blob (derived, reserved, never user-set)', () => {
  it('insert builds a lowercased _search blob from ALL scalar leaves (nested + arrays)', async () => {
    const { repo, dataContainer } = setup()
    const rec = await repo.insert({
      appId: A,
      collection: 'default',
      data: { gate: 'A5', inspector: 'R. Mehta', tags: ['Hinges', 'Greased'], meta: { status: 'Pass' }, count: 3, ok: true },
    })
    expect(dataContainer._get(rec._id)._search).toBe('a5 r. mehta hinges greased pass 3 true')
  })

  it('update recomputes _search from the MERGED object (untouched keys survive, replaced value gone)', async () => {
    const { repo, dataContainer } = setup()
    const rec = await repo.insert({ appId: A, collection: 'default', data: { gate: 'A5', status: 'open' } })
    await repo.update(A, rec._id, { status: 'closed' })
    const blob = dataContainer._get(rec._id)._search
    expect(blob).toContain('a5') // untouched key still searchable
    expect(blob).toContain('closed') // merged value
    expect(blob).not.toContain('open') // replaced value gone
  })

  it('a client-sent _search is stripped (server-owned reserved field)', () => {
    const out = sanitizeData({ _search: 'spoofed', gate: 'A5' })
    expect(out.ok).toBe(true)
    expect(out.value).toEqual({ gate: 'A5' })
  })
})

describe('data-records-repo — search (paged, generic, tenant-scoped)', () => {
  async function seed(repo) {
    await repo.insert({ appId: A, collection: 'inspections', data: { gate: 'A1', inspector: 'R. Mehta', status: 'Pass', notes: 'Hinges greased' } })
    await repo.insert({ appId: A, collection: 'inspections', data: { gate: 'A2', inspector: 'S. Rao', status: 'Fail', notes: 'Proximity sensor misaligned' } })
    await repo.insert({ appId: A, collection: 'inspections', data: { gate: 'B3', inspector: 'P. Nair', status: 'Pass', notes: 'No issues found' } })
    await repo.insert({ appId: A, collection: 'other', data: { gate: 'Z9', status: 'Pass' } })
    await repo.insert({ appId: B, collection: 'inspections', data: { gate: 'A1', status: 'Pass', notes: 'tenant B secret' } })
  }

  it('free-text q matches across ALL fields, case-insensitively', async () => {
    const { repo } = setup()
    await seed(repo)
    expect((await repo.search(A, { collection: 'inspections', q: 'sensor' })).items.map((x) => x.data.gate)).toEqual(['A2'])
    expect((await repo.search(A, { collection: 'inspections', q: 'mehta' })).items.map((x) => x.data.gate)).toEqual(['A1'])
    expect((await repo.search(A, { collection: 'inspections', q: 'PASS' })).total).toBe(2) // case-insensitive on status
  })

  it('paginates with a true total and echoes page/pageSize', async () => {
    const { repo } = setup()
    await seed(repo)
    const p1 = await repo.search(A, { collection: 'inspections', sortPath: 'data.gate', order: 'asc', page: 1, pageSize: 2 })
    expect({ total: p1.total, page: p1.page, pageSize: p1.pageSize }).toEqual({ total: 3, page: 1, pageSize: 2 })
    expect(p1.items.map((x) => x.data.gate)).toEqual(['A1', 'A2'])
    const p2 = await repo.search(A, { collection: 'inspections', sortPath: 'data.gate', order: 'asc', page: 2, pageSize: 2 })
    expect(p2.items.map((x) => x.data.gate)).toEqual(['B3'])
  })

  it('sorts by a data field ascending and descending', async () => {
    const { repo } = setup()
    await seed(repo)
    expect((await repo.search(A, { collection: 'inspections', sortPath: 'data.gate', order: 'asc' })).items.map((x) => x.data.gate)).toEqual(['A1', 'A2', 'B3'])
    expect((await repo.search(A, { collection: 'inspections', sortPath: 'data.gate', order: 'desc' })).items.map((x) => x.data.gate)).toEqual(['B3', 'A2', 'A1'])
  })

  it('filters by equality on data.<key>, with a true total', async () => {
    const { repo } = setup()
    await seed(repo)
    const r = await repo.search(A, { collection: 'inspections', dataFilter: { 'data.status': 'Pass' }, sortPath: 'data.gate', order: 'asc' })
    expect(r.items.map((x) => x.data.gate)).toEqual(['A1', 'B3'])
    expect(r.total).toBe(2)
  })

  it('combines q + equality filter', async () => {
    const { repo } = setup()
    await seed(repo)
    const r = await repo.search(A, { collection: 'inspections', dataFilter: { 'data.status': 'Pass' }, q: 'issues' })
    expect(r.items.map((x) => x.data.gate)).toEqual(['B3'])
    expect(r.total).toBe(1)
  })

  it('never returns another tenant’s rows (BOLA), even on a matching q', async () => {
    const { repo } = setup()
    await seed(repo)
    const own = await repo.search(B, { collection: 'inspections', q: 'secret' })
    expect(own.items.map((x) => x.data.gate)).toEqual(['A1'])
    expect(own.total).toBe(1)
    expect((await repo.search(B, { collection: 'inspections', q: 'mehta' })).total).toBe(0) // A-only text
  })

  it('clamps pageSize to the max and page to >= 1', async () => {
    const { repo } = setup()
    await seed(repo)
    const r = await repo.search(A, { collection: 'inspections', pageSize: 9999, page: 0 })
    expect(r.pageSize).toBe(100) // MAX_PAGE_SIZE
    expect(r.page).toBe(1)
  })
})

describe('data-records-repo — distinct (filter-dropdown values)', () => {
  it('returns unique values of data.<field> within the tenant + collection', async () => {
    const { repo } = setup()
    await repo.insert({ appId: A, collection: 'inspections', data: { status: 'Pass' } })
    await repo.insert({ appId: A, collection: 'inspections', data: { status: 'Fail' } })
    await repo.insert({ appId: A, collection: 'inspections', data: { status: 'Pass' } })
    await repo.insert({ appId: A, collection: 'other', data: { status: 'Escalated' } }) // other collection
    await repo.insert({ appId: B, collection: 'inspections', data: { status: 'TenantB' } }) // other tenant
    expect((await repo.distinct(A, { collection: 'inspections', field: 'status' })).sort()).toEqual(['Fail', 'Pass'])
  })

  it('drops records missing the field and stays tenant-scoped', async () => {
    const { repo } = setup()
    await repo.insert({ appId: A, collection: 'default', data: { status: 'Open' } })
    await repo.insert({ appId: A, collection: 'default', data: { other: 'x' } }) // no status field
    expect(await repo.distinct(A, { collection: 'default', field: 'status' })).toEqual(['Open'])
  })
})

describe('data-records-repo — backfillSearchDocs (idempotent migration)', () => {
  it('adds _search to legacy rows missing it, leaves the rest, and re-runs as a no-op', async () => {
    const { repo, dataContainer } = setup({
      records: [
        { _id: 'old1', appId: A, collection: 'default', data: { gate: 'A1', status: 'Pass' }, bytes: 5, createdAt: '2026-01-01T00:00:01.000Z' },
        { _id: 'old2', appId: A, collection: 'default', data: { gate: 'B2' }, bytes: 5, createdAt: '2026-01-01T00:00:02.000Z' },
        { _id: 'new1', appId: A, collection: 'default', data: { gate: 'C3' }, _search: 'c3', bytes: 5, createdAt: '2026-01-01T00:00:03.000Z' },
      ],
    })
    expect((await repo.backfillSearchDocs({})).updated).toBe(2)
    expect(dataContainer._get('old1')._search).toBe('a1 pass')
    expect(dataContainer._get('old2')._search).toBe('b2')
    expect(dataContainer._get('new1')._search).toBe('c3') // already had one → untouched
    expect((await repo.backfillSearchDocs({})).updated).toBe(0) // idempotent
  })

  it('scopes to one appId when given', async () => {
    const { repo, dataContainer } = setup({
      records: [
        { _id: 'a1', appId: A, collection: 'default', data: { x: 'aaa' }, bytes: 5 },
        { _id: 'b1', appId: B, collection: 'default', data: { x: 'bbb' }, bytes: 5 },
      ],
    })
    expect((await repo.backfillSearchDocs({ appId: A })).updated).toBe(1)
    expect(dataContainer._get('a1')._search).toBe('aaa')
    expect(dataContainer._get('b1')._search).toBeUndefined() // B left for its own run
  })
})

describe('data-records-repo — query helpers (pure, shared with the route)', () => {
  it('buildSearchBlob lowercases + space-joins scalar leaves; empty for {}/null', () => {
    expect(buildSearchBlob({ a: 'Hello', b: 5, c: true, nested: { d: 'World' }, list: ['X', 'y'] })).toBe('hello 5 true world x y')
    expect(buildSearchBlob({})).toBe('')
    expect(buildSearchBlob(null)).toBe('')
  })

  it('escapeRegex neutralises regex metacharacters (literal substring match)', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c')
  })

  it('resolveSortPath whitelists timestamps, maps data fields, rejects injection/reserved', () => {
    expect(resolveSortPath(undefined)).toEqual({ ok: true, value: 'createdAt' })
    expect(resolveSortPath('updatedAt')).toEqual({ ok: true, value: 'updatedAt' })
    expect(resolveSortPath('gate')).toEqual({ ok: true, value: 'data.gate' })
    expect(resolveSortPath('a.b').ok).toBe(false)
    expect(resolveSortPath('$where').ok).toBe(false)
    expect(resolveSortPath('_id').ok).toBe(false)
  })

  it('buildDataFilter prefixes data., rejects operator keys + non-scalar values, allows null', () => {
    expect(buildDataFilter({ status: 'Pass', count: 3 })).toEqual({ ok: true, value: { 'data.status': 'Pass', 'data.count': 3 } })
    expect(buildDataFilter(undefined)).toEqual({ ok: true, value: {} })
    expect(buildDataFilter({ active: null })).toEqual({ ok: true, value: { 'data.active': null } })
    expect(buildDataFilter({ $where: 1 }).ok).toBe(false)
    expect(buildDataFilter({ 'a.b': 1 }).ok).toBe(false)
    expect(buildDataFilter({ _id: 'x' }).ok).toBe(false)
    expect(buildDataFilter({ tags: ['a'] }).ok).toBe(false) // array value
    expect(buildDataFilter({ meta: { x: 1 } }).ok).toBe(false) // nested object value
    expect(buildDataFilter('nope').ok).toBe(false)
  })

  it('sanitizeFieldName rejects empty / operator / dotted / reserved', () => {
    expect(sanitizeFieldName('status')).toEqual({ ok: true, value: 'status' })
    expect(sanitizeFieldName('').ok).toBe(false)
    expect(sanitizeFieldName('$x').ok).toBe(false)
    expect(sanitizeFieldName('a.b').ok).toBe(false)
    expect(sanitizeFieldName('_search').ok).toBe(false)
  })
})
