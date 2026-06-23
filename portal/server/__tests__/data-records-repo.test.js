import { describe, it, expect } from 'vitest'
import {
  createDataRecordsRepo,
  sanitizeData,
  sanitizeCollection,
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
