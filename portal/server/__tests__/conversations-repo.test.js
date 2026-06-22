import { describe, it, expect } from 'vitest'
import { createConversationsRepo } from '../conversations-repo.js'
import { makeFakeConversationsContainer } from './fakeConversationsCosmos.js'

const A = 'alice@bial.test'
const B = 'bob@bial.test'

const header = (id, username, extra = {}) => ({
  _id: id,
  username,
  kind: 'planning',
  title: `title ${id}`,
  createdAt: '2026-06-20T09:00:00.000Z',
  ...extra,
})

/** Wrap a container so the first updateOne throws a Cosmos RU-throttle (16500). */
function throttleUpdateOnce(base) {
  let calls = 0
  return {
    ...base,
    async updateOne(...args) {
      calls += 1
      if (calls === 1) {
        const err = new Error('TooManyRequests')
        err.code = 16500
        throw err
      }
      return base.updateOne(...args)
    },
  }
}

describe('conversations-repo — upsertHeader', () => {
  it('inserts then idempotently updates on a repeat with the same _id+username', async () => {
    const c = makeFakeConversationsContainer([])
    const repo = createConversationsRepo(c)
    await repo.upsertHeader(header('conv-1', A, { title: 'first' }))
    expect(c._get('conv-1')).toMatchObject({ _id: 'conv-1', username: A, kind: 'planning', title: 'first' })
    expect(c._get('conv-1').createdAt).toBe('2026-06-20T09:00:00.000Z')

    await repo.upsertHeader(header('conv-1', A, { title: 'renamed' }))
    expect(c._store.size).toBe(1) // no duplicate row
    expect(c._get('conv-1').title).toBe('renamed')
  })

  it('does NOT clobber code.current or createdAt on an append-time re-upsert', async () => {
    const c = makeFakeConversationsContainer([])
    const repo = createConversationsRepo(c)
    await repo.upsertHeader(header('b-1', A, { kind: 'builder', title: 'app' }))
    await repo.patchCode('b-1', A, { source: 'JSX', entry: 'PreviewApp' })
    // Assistant-turn re-upsert (no title/context, no code in the payload).
    await repo.upsertHeader({ _id: 'b-1', username: A, kind: 'builder' })
    expect(c._get('b-1').code.current).toEqual({ source: 'JSX', entry: 'PreviewApp' })
    expect(c._get('b-1').createdAt).toBe('2026-06-20T09:00:00.000Z')
    expect(c._get('b-1').title).toBe('app') // omitted title preserved
  })

  it('does NOT overwrite a header owned by a DIFFERENT username (write-IDOR closed)', async () => {
    const c = makeFakeConversationsContainer([header('shared-id', A, { title: 'alice owns this' })])
    const repo = createConversationsRepo(c)
    await expect(repo.upsertHeader(header('shared-id', B, { title: 'bob hijack' }))).rejects.toThrow(/E11000/)
    expect(c._get('shared-id')).toMatchObject({ username: A, title: 'alice owns this' })
    expect(c._store.size).toBe(1)
  })

  it('retries a throttle (16500) and stores exactly one doc', async () => {
    const base = makeFakeConversationsContainer([])
    const repo = createConversationsRepo(throttleUpdateOnce(base))
    await repo.upsertHeader(header('conv-1', A))
    expect(base._store.size).toBe(1)
  })

  it('does NOT retry a non-throttle error', async () => {
    const base = makeFakeConversationsContainer([])
    const repo = createConversationsRepo({
      ...base,
      async updateOne() {
        throw new Error('boom')
      },
    })
    await expect(repo.upsertHeader(header('conv-1', A))).rejects.toThrow('boom')
    expect(base._store.size).toBe(0)
  })
})

describe('conversations-repo — listByUser', () => {
  it('returns only the caller headers, newest-first, filtered by kind', async () => {
    const c = makeFakeConversationsContainer([
      header('a1', A, { kind: 'planning', updatedAt: '2026-06-20T10:00:00.000Z' }),
      header('a2', A, { kind: 'planning', updatedAt: '2026-06-20T12:00:00.000Z' }),
      header('a3', A, { kind: 'builder', updatedAt: '2026-06-20T11:00:00.000Z' }),
      header('b1', B, { kind: 'planning', updatedAt: '2026-06-20T13:00:00.000Z' }),
    ])
    const repo = createConversationsRepo(c)
    const planning = await repo.listByUser(A, 'planning')
    expect(planning.map((d) => d._id)).toEqual(['a2', 'a1']) // newest-first, only A's planning
    const all = await repo.listByUser(A)
    expect(all.map((d) => d._id).sort()).toEqual(['a1', 'a2', 'a3']) // no B
  })

  it('returns [] for a user with no conversations', async () => {
    const repo = createConversationsRepo(makeFakeConversationsContainer([]))
    expect(await repo.listByUser(A)).toEqual([])
  })
})

describe('conversations-repo — getHeader / patchCode / deleteHeader (per-user scoped)', () => {
  it('getHeader returns the owner doc and null for a different user', async () => {
    const c = makeFakeConversationsContainer([header('c1', A)])
    const repo = createConversationsRepo(c)
    expect(await repo.getHeader('c1', A)).toMatchObject({ _id: 'c1', username: A })
    expect(await repo.getHeader('c1', B)).toBeNull()
  })

  it('patchCode sets code.current for the owner; a cross-user patch changes nothing', async () => {
    const c = makeFakeConversationsContainer([header('c1', A, { kind: 'builder' })])
    const repo = createConversationsRepo(c)
    await repo.patchCode('c1', A, { source: 'CODE', entry: 'PreviewApp', model: 'opus' })
    expect(c._get('c1').code.current).toMatchObject({ source: 'CODE', entry: 'PreviewApp' })

    await repo.patchCode('c1', B, { source: 'HIJACK' })
    expect(c._get('c1').code.current.source).toBe('CODE') // unchanged
  })

  it('deleteHeader removes only the owner doc; a cross-user delete removes nothing', async () => {
    const c = makeFakeConversationsContainer([header('c1', A)])
    const repo = createConversationsRepo(c)
    expect((await repo.deleteHeader('c1', B)).deletedCount).toBe(0)
    expect(c._store.size).toBe(1)
    expect((await repo.deleteHeader('c1', A)).deletedCount).toBe(1)
    expect(c._store.size).toBe(0)
  })
})
