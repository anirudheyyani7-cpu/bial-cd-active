import { describe, it, expect } from 'vitest'
import {
  createAppRegistryRepo,
  validateAppRegistration,
  APP_RECORD_COUNT_CAP,
  APP_DATA_BYTES_CAP,
  APP_FILE_COUNT_CAP,
  APP_FILE_BYTES_CAP,
  MAX_APP_NAME,
} from '../app-registry-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'

const APP = 'app-1'
const OWNER = 'alice'

function setup(initialDocs = []) {
  const container = makeFakeAppRegistryContainer(initialDocs)
  const repo = createAppRegistryRepo(container)
  return { container, repo }
}

describe('app-registry-repo — ensureDraft (idempotent provision)', () => {
  it('inserts a draft once, minting a non-secret appKey + zeroed counters', async () => {
    const { repo, container } = setup()
    const doc = await repo.ensureDraft(APP, OWNER)
    expect(doc._id).toBe(APP)
    expect(doc.status).toBe('draft')
    expect(doc.ownerUsername).toBe(OWNER)
    expect(doc.loginRequired).toBe(false)
    expect(doc.dataCount).toBe(0)
    expect(doc.dataBytes).toBe(0)
    expect(doc.fileCount).toBe(0)
    expect(doc.fileBytes).toBe(0)
    expect(doc.appKey).toMatch(/^bial_[A-Za-z0-9_-]+$/)
    expect(container._store.size).toBe(1)
  })

  it('is idempotent: a second call returns the same appId/appKey, never re-minting or clobbering', async () => {
    const { repo, container } = setup()
    const first = await repo.ensureDraft(APP, OWNER)
    // Mutate a field a later submit would set, then ensureDraft again.
    await repo.setStatus(APP, 'pending')
    const second = await repo.ensureDraft(APP, 'someone-else')
    expect(second._id).toBe(APP)
    expect(second.appKey).toBe(first.appKey) // key not re-minted
    expect(second.ownerUsername).toBe(OWNER) // owner not clobbered
    expect(second.status).toBe('pending') // status untouched by ensureDraft
    expect(container._store.size).toBe(1)
  })
})

describe('app-registry-repo — getApp / getByKey / listApps', () => {
  it('getByKey returns the app for a valid key; an unknown key → null', async () => {
    const { repo } = setup()
    const draft = await repo.ensureDraft(APP, OWNER)
    expect((await repo.getByKey(draft.appKey))._id).toBe(APP)
    expect(await repo.getByKey('bial_nope')).toBeNull()
  })

  it('getApp returns null on miss', async () => {
    const { repo } = setup()
    expect(await repo.getApp('ghost')).toBeNull()
  })

  it('listApps filters by status and returns newest-first, capped', async () => {
    const { repo } = setup([
      { _id: 'a', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' },
      { _id: 'b', status: 'approved', createdAt: '2026-02-01T00:00:00.000Z' },
      { _id: 'c', status: 'pending', createdAt: '2026-03-01T00:00:00.000Z' },
    ])
    const pending = await repo.listApps({ status: 'pending' })
    expect(pending.map((d) => d._id)).toEqual(['c', 'a']) // newest-first
    const all = await repo.listApps({})
    expect(all).toHaveLength(3)
    const capped = await repo.listApps({ limit: 1 })
    expect(capped).toHaveLength(1)
  })
})

describe('app-registry-repo — setStatus (atomic transition machine)', () => {
  it('allows draft→pending→approved and approved→pending', async () => {
    const { repo } = setup()
    await repo.ensureDraft(APP, OWNER)
    expect((await repo.setStatus(APP, 'pending')).ok).toBe(true)
    expect((await repo.setStatus(APP, 'approved', { approvedBy: 'admin' })).ok).toBe(true)
    expect((await repo.getApp(APP)).approvedBy).toBe('admin')
    expect((await repo.setStatus(APP, 'pending')).ok).toBe(true) // re-submit on approved
    expect((await repo.getApp(APP)).status).toBe('pending')
  })

  it('rejects approved→approved and draft→approved (illegal transitions)', async () => {
    const { repo } = setup()
    await repo.ensureDraft(APP, OWNER)
    // draft→approved is illegal (must go through pending).
    expect((await repo.setStatus(APP, 'approved')).ok).toBe(false)
    expect((await repo.getApp(APP)).status).toBe('draft')
    // Drive to approved legally, then approved→approved must be rejected.
    await repo.setStatus(APP, 'pending')
    await repo.setStatus(APP, 'approved')
    expect((await repo.setStatus(APP, 'approved')).ok).toBe(false)
  })

  it('returns ok:false for a missing app and throws on an unknown target status', async () => {
    const { repo } = setup()
    expect((await repo.setStatus('ghost', 'pending')).ok).toBe(false)
    await repo.ensureDraft(APP, OWNER)
    await expect(repo.setStatus(APP, 'bananas')).rejects.toThrow(/Unknown target status/)
  })
})

describe('app-registry-repo — setSnapshots / patchApp', () => {
  it('setSnapshots writes code.source without touching code.approvedSnapshot, and vice-versa', async () => {
    const { repo } = setup()
    await repo.ensureDraft(APP, OWNER)
    await repo.setSnapshots(APP, { source: { src: 'v1', entry: 'PreviewApp' } })
    let doc = await repo.getApp(APP)
    expect(doc.code.source.src).toBe('v1')
    expect(doc.code.approvedSnapshot).toBeUndefined()

    await repo.setSnapshots(APP, { approvedSnapshot: { compiled: 'JS', src: 'v1', by: 'admin' } })
    doc = await repo.getApp(APP)
    expect(doc.code.approvedSnapshot.compiled).toBe('JS')
    expect(doc.code.source.src).toBe('v1') // source preserved

    await repo.setSnapshots(APP, { source: { src: 'v2', entry: 'PreviewApp' } })
    doc = await repo.getApp(APP)
    expect(doc.code.source.src).toBe('v2')
    expect(doc.code.approvedSnapshot.compiled).toBe('JS') // approvedSnapshot preserved
  })

  it('patchApp updates loginRequired/name/dataSchema without touching appKey/status', async () => {
    const { repo } = setup()
    const draft = await repo.ensureDraft(APP, OWNER)
    await repo.patchApp(APP, { name: 'Inspections', loginRequired: true, dataSchema: { collection: 'default', fields: ['a'] } })
    const doc = await repo.getApp(APP)
    expect(doc.name).toBe('Inspections')
    expect(doc.loginRequired).toBe(true)
    expect(doc.dataSchema).toEqual({ collection: 'default', fields: ['a'] })
    expect(doc.appKey).toBe(draft.appKey) // identity untouched
    expect(doc.status).toBe('draft') // status untouched
  })
})

describe('app-registry-repo — incData (atomic quota reserve + release)', () => {
  it('increments and decrements the counters atomically', async () => {
    const { repo } = setup()
    await repo.ensureDraft(APP, OWNER)
    const up = await repo.incData(APP, 1, 500)
    expect(up.dataCount).toBe(1)
    expect(up.dataBytes).toBe(500)
    const down = await repo.incData(APP, -1, -500)
    expect(down.dataCount).toBe(0)
    expect(down.dataBytes).toBe(0)
  })

  it('returns null (no increment) when the count cap would be exceeded', async () => {
    const { repo, container } = setup([
      { _id: APP, status: 'draft', dataCount: APP_RECORD_COUNT_CAP, dataBytes: 0 },
    ])
    expect(await repo.incData(APP, 1, 10)).toBeNull()
    expect(container._get(APP).dataCount).toBe(APP_RECORD_COUNT_CAP) // unchanged
  })

  it('returns null (no increment) when the byte cap would be exceeded', async () => {
    const { repo, container } = setup([
      { _id: APP, status: 'draft', dataCount: 0, dataBytes: APP_DATA_BYTES_CAP },
    ])
    expect(await repo.incData(APP, 1, 1)).toBeNull()
    expect(container._get(APP).dataBytes).toBe(APP_DATA_BYTES_CAP) // unchanged
  })

  it('two concurrent near-cap reserves cannot BOTH pass (atomic conditional)', async () => {
    const { repo, container } = setup([
      { _id: APP, status: 'draft', dataCount: APP_RECORD_COUNT_CAP - 1, dataBytes: 0 },
    ])
    const results = await Promise.all([repo.incData(APP, 1, 1), repo.incData(APP, 1, 1)])
    const passed = results.filter(Boolean)
    expect(passed).toHaveLength(1) // exactly one reserved the last slot
    expect(container._get(APP).dataCount).toBe(APP_RECORD_COUNT_CAP) // no over-count
  })

  it('a decrement always applies even at the cap (release raises the threshold)', async () => {
    const { repo } = setup([
      { _id: APP, status: 'draft', dataCount: APP_RECORD_COUNT_CAP, dataBytes: APP_DATA_BYTES_CAP },
    ])
    const down = await repo.incData(APP, -1, -100)
    expect(down.dataCount).toBe(APP_RECORD_COUNT_CAP - 1)
    expect(down.dataBytes).toBe(APP_DATA_BYTES_CAP - 100)
  })
})

describe('app-registry-repo — incFiles / setFileCounters (separate file quota)', () => {
  it('increments and decrements the FILE counters atomically (independent of data counters)', async () => {
    const { repo } = setup()
    await repo.ensureDraft(APP, OWNER)
    const up = await repo.incFiles(APP, 1, 4096)
    expect(up.fileCount).toBe(1)
    expect(up.fileBytes).toBe(4096)
    expect(up.dataCount).toBe(0) // record quota untouched
    const down = await repo.incFiles(APP, -1, -4096)
    expect(down.fileCount).toBe(0)
    expect(down.fileBytes).toBe(0)
  })

  it('returns null when the file count or byte cap would be exceeded (counters unchanged)', async () => {
    const { repo, container } = setup([
      { _id: APP, status: 'draft', fileCount: APP_FILE_COUNT_CAP, fileBytes: 0 },
    ])
    expect(await repo.incFiles(APP, 1, 10)).toBeNull()
    expect(container._get(APP).fileCount).toBe(APP_FILE_COUNT_CAP)
    const { repo: repo2, container: c2 } = setup([
      { _id: APP, status: 'draft', fileCount: 0, fileBytes: APP_FILE_BYTES_CAP },
    ])
    expect(await repo2.incFiles(APP, 1, 1)).toBeNull()
    expect(c2._get(APP).fileBytes).toBe(APP_FILE_BYTES_CAP)
  })

  it('backfills missing file counters on a pre-existing app before reserving (no false 413)', async () => {
    // A registry doc created before this feature has dataCount but NO fileCount.
    const { repo } = setup([{ _id: APP, status: 'approved', dataCount: 3, dataBytes: 90 }])
    const up = await repo.incFiles(APP, 1, 100)
    expect(up).not.toBeNull() // would be null if the $lte filter missed the absent field
    expect(up.fileCount).toBe(1)
    expect(up.fileBytes).toBe(100)
  })

  it('setFileCounters resets both counters to an exact pair', async () => {
    const { repo, container } = setup([
      { _id: APP, status: 'draft', fileCount: 9, fileBytes: 9999 },
    ])
    await repo.setFileCounters(APP, { fileCount: 0, fileBytes: 0 })
    expect(container._get(APP).fileCount).toBe(0)
    expect(container._get(APP).fileBytes).toBe(0)
  })
})

describe('app-registry-repo — throttle resilience', () => {
  it('retries a Cosmos throttle (16500) on incData then succeeds; a non-throttle propagates', async () => {
    const base = makeFakeAppRegistryContainer([{ _id: APP, status: 'draft', dataCount: 0, dataBytes: 0 }])
    let calls = 0
    const flaky = {
      ...base,
      async findOneAndUpdate(...args) {
        calls += 1
        if (calls === 1) {
          const err = new Error('TooManyRequests')
          err.code = 16500
          throw err
        }
        return base.findOneAndUpdate(...args)
      },
    }
    const repo = createAppRegistryRepo(flaky)
    const up = await repo.incData(APP, 1, 10)
    expect(up.dataCount).toBe(1)
    expect(calls).toBe(2) // retried once

    const boom = {
      ...base,
      async findOneAndUpdate() {
        const err = new Error('boom')
        err.code = 500
        throw err
      },
    }
    await expect(createAppRegistryRepo(boom).incData(APP, 1, 10)).rejects.toThrow('boom')
  })
})

describe('validateAppRegistration', () => {
  it('accepts a sparse valid patch and trims the name', async () => {
    expect(validateAppRegistration({ name: '  Inspections  ', loginRequired: true })).toEqual({
      ok: true,
      value: { name: 'Inspections', loginRequired: true },
    })
    expect(validateAppRegistration({})).toEqual({ ok: true, value: {} })
  })

  it('rejects a non-string name, an over-long name, and a non-boolean loginRequired', async () => {
    expect(validateAppRegistration({ name: 5 }).ok).toBe(false)
    expect(validateAppRegistration({ name: 'x'.repeat(MAX_APP_NAME + 1) }).ok).toBe(false)
    expect(validateAppRegistration({ loginRequired: 'yes' }).ok).toBe(false)
    expect(validateAppRegistration(null).ok).toBe(false)
    expect(validateAppRegistration([]).ok).toBe(false)
  })
})
