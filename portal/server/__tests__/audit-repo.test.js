import { describe, it, expect } from 'vitest'
import { createAuditRepo } from '../audit-repo.js'
import { makeFakeAuditContainer } from './fakeAuditCosmos.js'

const A = 'app-A'
const B = 'app-B'

function setup(initialDocs = []) {
  const container = makeFakeAuditContainer(initialDocs)
  const repo = createAuditRepo(container)
  return { container, repo }
}

describe('audit-repo — record (append-only, contents never stored)', () => {
  it('appends a data-mutation event with actor/action/recordId and a timestamp', async () => {
    const { repo, container } = setup()
    await repo.record({ appId: A, username: 'alice', action: 'create', collection: 'default', recordId: 'rec-1' })
    const docs = [...container._store.values()]
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ appId: A, username: 'alice', action: 'create', collection: 'default', recordId: 'rec-1' })
    expect(docs[0]._id).toBeTypeOf('string')
    expect(docs[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // contents are not part of the event shape — only ids/actor/action are stored
    expect(docs[0]).not.toHaveProperty('data')
  })

  it('appends an admin event (config:loginRequired) with actor + count', async () => {
    const { repo, container } = setup()
    await repo.record({ appId: A, username: 'admin', action: 'config:loginRequired', count: 1 })
    const doc = [...container._store.values()][0]
    expect(doc).toMatchObject({ appId: A, username: 'admin', action: 'config:loginRequired', count: 1 })
    // optional fields absent when not provided (clean shape)
    expect(doc).not.toHaveProperty('recordId')
    expect(doc).not.toHaveProperty('collection')
  })

  it('records a null actor for an anonymous open-app write', async () => {
    const { repo, container } = setup()
    await repo.record({ appId: A, username: undefined, action: 'create', recordId: 'rec-x' })
    expect([...container._store.values()][0].username).toBeNull()
  })
})

describe('audit-repo — listByApp', () => {
  it('returns only that app’s events, newest-first, capped', async () => {
    const { repo } = setup([
      { _id: 'e1', appId: A, username: 'alice', action: 'create', at: '2026-01-01T00:00:01.000Z' },
      { _id: 'e2', appId: B, username: 'bob', action: 'create', at: '2026-01-01T00:00:02.000Z' },
      { _id: 'e3', appId: A, username: 'alice', action: 'delete', at: '2026-01-01T00:00:03.000Z' },
    ])
    const events = await repo.listByApp(A)
    expect(events.map((e) => e._id)).toEqual(['e3', 'e1']) // only A, newest-first
    expect(await repo.listByApp(A, { limit: 1 })).toHaveLength(1)
    expect(await repo.listByApp('ghost')).toHaveLength(0)
  })
})

describe('audit-repo — throttle resilience', () => {
  it('retries a Cosmos throttle (16500) on record then succeeds', async () => {
    const base = makeFakeAuditContainer()
    let calls = 0
    const flaky = {
      ...base,
      async insertOne(doc) {
        calls += 1
        if (calls === 1) {
          const err = new Error('TooManyRequests')
          err.code = 16500
          throw err
        }
        return base.insertOne(doc)
      },
    }
    const repo = createAuditRepo(flaky)
    await repo.record({ appId: A, username: 'alice', action: 'create' })
    expect(calls).toBe(2)
    expect(base._store.size).toBe(1)
  })
})
