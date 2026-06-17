import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createUsersRepo } from '../users-repo.js'
import { makeFakeContainer } from './fakeCosmos.js'

function makeUser(overrides = {}) {
  return {
    _id: 'alice',
    username: 'alice',
    email: 'alice@bial.test',
    name: 'Alice',
    role: 'user',
    passwordHash: '$argon2id$v=19$x',
    refreshTokenHash: null,
    refreshTokenExpiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('users-repo', () => {
  it('findByUsername returns the doc for an existing user', async () => {
    const repo = createUsersRepo(makeFakeContainer([makeUser()]))
    const found = await repo.findByUsername('alice')
    expect(found).toMatchObject({ username: 'alice', role: 'user' })
  })

  it('findByUsername returns null when no document matches (findOne miss, no throw)', async () => {
    const repo = createUsersRepo(makeFakeContainer([]))
    await expect(repo.findByUsername('nobody')).resolves.toBeNull()
  })

  it('setRefreshHash writes both hash and expiry together', async () => {
    const container = makeFakeContainer([makeUser()])
    const repo = createUsersRepo(container)
    await repo.setRefreshHash('alice', 'HASH', '2026-02-01T00:00:00.000Z')
    const stored = container._get('alice')
    expect(stored.refreshTokenHash).toBe('HASH')
    expect(stored.refreshTokenExpiresAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('clearRefreshHash nulls both hash and expiry together', async () => {
    const container = makeFakeContainer([
      makeUser({ refreshTokenHash: 'HASH', refreshTokenExpiresAt: '2026-02-01T00:00:00.000Z' }),
    ])
    const repo = createUsersRepo(container)
    await repo.clearRefreshHash('alice')
    const stored = container._get('alice')
    expect(stored.refreshTokenHash).toBeNull()
    expect(stored.refreshTokenExpiresAt).toBeNull()
  })

  it('upsertUser is idempotent — second call replaces, no duplicate', async () => {
    const container = makeFakeContainer([])
    const repo = createUsersRepo(container)
    await repo.upsertUser(makeUser({ name: 'First' }))
    await repo.upsertUser(makeUser({ name: 'Second' }))
    expect(container._store.size).toBe(1)
    expect(container._get('alice').name).toBe('Second')
  })

  it('setRefreshHash also stamps updatedAt', async () => {
    const container = makeFakeContainer([makeUser()])
    const repo = createUsersRepo(container)
    await repo.setRefreshHash('alice', 'H', '2026-02-01T00:00:00.000Z')
    expect(container._get('alice').updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
  })

  it('set/clearRefreshHash on a missing user reject (updateOne matched 0) — caller decides how to handle', async () => {
    const repo = createUsersRepo(makeFakeContainer([]))
    await expect(repo.clearRefreshHash('ghost')).rejects.toThrow()
    await expect(repo.setRefreshHash('ghost', 'H', '2026-02-01T00:00:00.000Z')).rejects.toThrow()
  })
})

describe('mongo env guard', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.MONGODB_URI
  })
  afterEach(() => {
    process.env = { ...saved }
    vi.resetModules()
  })

  it('getMongoClient rejects with a clear error when MONGODB_URI is missing', async () => {
    vi.resetModules()
    const { getMongoClient } = await import('../cosmos.js')
    await expect(getMongoClient()).rejects.toThrow(/Missing required Mongo env var/)
  })

  it('getUsageCollection rejects with a clear error when MONGODB_USAGE_COLLECTION is missing', async () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017/?directConnection=true'
    process.env.MONGODB_DATABASE = 'citizen_portal'
    delete process.env.MONGODB_USAGE_COLLECTION
    vi.resetModules()
    const { getUsageCollection } = await import('../cosmos.js')
    await expect(getUsageCollection()).rejects.toThrow(/Missing required Mongo env var/)
  })
})
