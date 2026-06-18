import { describe, it, expect } from 'vitest'
import { createUsageRepo, istDateKey, nextIstMidnightIso } from '../usage-repo.js'
import { makeFakeUsageContainer } from './fakeUsageCosmos.js'

describe('usage-repo', () => {
  it('getUsage returns null for a never-seen username:date', async () => {
    const repo = createUsageRepo(makeFakeUsageContainer([]))
    await expect(repo.getUsage('alice@bial.test', '2026-06-17')).resolves.toBeNull()
  })

  it('addUsage on a missing key inserts a doc (upsert path) with username/date/createdAt', async () => {
    const container = makeFakeUsageContainer([])
    const repo = createUsageRepo(container)
    await repo.addUsage('alice@bial.test', '2026-06-17', 100, 40)
    const doc = container._get('alice@bial.test:2026-06-17')
    expect(doc).toMatchObject({
      _id: 'alice@bial.test:2026-06-17',
      username: 'alice@bial.test',
      date: '2026-06-17',
      inputTokens: 100,
      outputTokens: 40,
    })
    expect(typeof doc.createdAt).toBe('string')
    expect(typeof doc.updatedAt).toBe('string')
  })

  it('addUsage called twice accumulates via $inc (100+250 input → 350)', async () => {
    const container = makeFakeUsageContainer([])
    const repo = createUsageRepo(container)
    await repo.addUsage('alice', '2026-06-17', 100, 10)
    await repo.addUsage('alice', '2026-06-17', 250, 30)
    const doc = container._get('alice:2026-06-17')
    expect(doc.inputTokens).toBe(350)
    expect(doc.outputTokens).toBe(40)
    // createdAt is stamped only on insert ($setOnInsert), not refreshed.
    expect(typeof doc.createdAt).toBe('string')
  })

  it('doc _id is exactly `${username}:${dateKey}` and updatedAt is stamped/refreshed', async () => {
    const container = makeFakeUsageContainer([])
    const repo = createUsageRepo(container)
    await repo.addUsage('bob@bial.test', '2026-06-17', 5, 5)
    expect(container._store.has('bob@bial.test:2026-06-17')).toBe(true)
    const first = container._get('bob@bial.test:2026-06-17').updatedAt
    await repo.addUsage('bob@bial.test', '2026-06-17', 5, 5)
    const second = container._get('bob@bial.test:2026-06-17').updatedAt
    // ISO strings sort lexicographically; a later/equal stamp is acceptable.
    expect(second >= first).toBe(true)
  })

  it('getUsage reads back a doc inserted by addUsage', async () => {
    const container = makeFakeUsageContainer([])
    const repo = createUsageRepo(container)
    await repo.addUsage('carol', '2026-06-17', 7, 3)
    const doc = await repo.getUsage('carol', '2026-06-17')
    expect(doc).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  })
})

describe('istDateKey', () => {
  it('returns the IST calendar date, crossing the IST-midnight boundary', () => {
    // 2026-06-16T20:00:00Z == 2026-06-17T01:30 IST → next IST day
    expect(istDateKey(new Date('2026-06-16T20:00:00Z'))).toBe('2026-06-17')
    // 2026-06-16T18:29:00Z == 2026-06-16T23:59 IST → still the 16th
    expect(istDateKey(new Date('2026-06-16T18:29:00Z'))).toBe('2026-06-16')
    // 2026-06-16T18:30:00Z == 2026-06-17T00:00 IST → rolls to the 17th (boundary)
    expect(istDateKey(new Date('2026-06-16T18:30:00Z'))).toBe('2026-06-17')
  })
})

describe('nextIstMidnightIso', () => {
  it('returns the next IST midnight as a UTC ISO string', () => {
    // now == 2026-06-17T01:30 IST → next IST midnight is 2026-06-18T00:00 IST
    expect(nextIstMidnightIso(new Date('2026-06-16T20:00:00Z'))).toBe('2026-06-17T18:30:00.000Z')
  })

  it('handles a month-end roll (UTC math normalizes the overflow)', () => {
    // 2026-06-30T19:00:00Z == 2026-07-01T00:30 IST → next IST midnight 2026-07-02T00:00 IST
    expect(nextIstMidnightIso(new Date('2026-06-30T19:00:00Z'))).toBe('2026-07-01T18:30:00.000Z')
  })
})

describe('makeFakeUsageContainer', () => {
  it('updateOne with $inc + upsert inserts then increments', async () => {
    const c = makeFakeUsageContainer([])
    await c.updateOne({ _id: 'k' }, { $inc: { n: 2 }, $setOnInsert: { seeded: true } }, { upsert: true })
    expect(c._get('k')).toMatchObject({ n: 2, seeded: true })
    await c.updateOne({ _id: 'k' }, { $inc: { n: 3 } }, { upsert: true })
    expect(c._get('k').n).toBe(5)
  })

  it('a $set-only updateOne on a miss (no upsert) does not crash and matches nothing', async () => {
    const c = makeFakeUsageContainer([])
    const res = await c.updateOne({ _id: 'absent' }, { $set: { x: 1 } })
    expect(res.matchedCount).toBe(0)
    expect(c._get('absent')).toBeUndefined()
  })
})
