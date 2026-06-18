import { describe, it, expect } from 'vitest'
import { createFeedbackRepo } from '../feedback-repo.js'
import { makeFakeFeedbackContainer } from './fakeFeedbackCosmos.js'

const doc = (id, createdAt, extra = {}) => ({
  _id: id,
  username: 'alice@bial.test',
  message: `msg ${id}`,
  page: '/chat',
  createdAt,
  ...extra,
})

/** Wrap a container so the first insertOne throws a Cosmos RU-throttle (16500). */
function throttleInsertOnce(base) {
  let calls = 0
  return {
    ...base,
    async insertOne(d) {
      calls += 1
      if (calls === 1) {
        const err = new Error('TooManyRequests')
        err.code = 16500
        throw err
      }
      return base.insertOne(d)
    },
  }
}

describe('feedback-repo — addFeedback', () => {
  it('persists a doc keyed by _id with all fields intact', async () => {
    const container = makeFakeFeedbackContainer([])
    const repo = createFeedbackRepo(container)
    const d = doc('id-1', '2026-06-18T09:00:00.000Z')
    await repo.addFeedback(d)
    expect(container._get('id-1')).toEqual(d)
  })

  it('retries a Cosmos throttle (16500) and stores exactly one doc (no duplicate)', async () => {
    const base = makeFakeFeedbackContainer([])
    const repo = createFeedbackRepo(throttleInsertOnce(base))
    await repo.addFeedback(doc('id-1', '2026-06-18T09:00:00.000Z'))
    expect(base._store.size).toBe(1)
    expect(base._get('id-1')).toBeDefined()
  })

  it('does NOT retry a non-throttle error: it propagates and stores nothing', async () => {
    const base = makeFakeFeedbackContainer([])
    const container = {
      ...base,
      async insertOne() {
        throw new Error('boom')
      },
    }
    const repo = createFeedbackRepo(container)
    await expect(repo.addFeedback(doc('id-1', '2026-06-18T09:00:00.000Z'))).rejects.toThrow('boom')
    expect(base._store.size).toBe(0)
  })
})

describe('feedback-repo — listFeedback', () => {
  it('returns rows newest-first (descending createdAt)', async () => {
    const container = makeFakeFeedbackContainer([
      doc('a', '2026-06-18T09:00:00.000Z'),
      doc('b', '2026-06-18T10:00:00.000Z'),
      doc('c', '2026-06-18T11:00:00.000Z'),
    ])
    const repo = createFeedbackRepo(container)
    const rows = await repo.listFeedback()
    expect(rows.map((r) => r._id)).toEqual(['c', 'b', 'a'])
  })

  it('honors the cap: 205 docs → exactly the 200 newest', async () => {
    const seed = Array.from({ length: 205 }, (_, i) =>
      doc(`id-${String(i).padStart(3, '0')}`, `2026-06-18T${String(i % 24).padStart(2, '0')}:00:00.${String(i).padStart(3, '0')}Z`),
    )
    const repo = createFeedbackRepo(makeFakeFeedbackContainer(seed))
    const rows = await repo.listFeedback({ limit: 200 })
    expect(rows).toHaveLength(200)
    // Newest 200 means the 5 oldest createdAt are excluded; verify ordering holds.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].createdAt >= rows[i].createdAt).toBe(true)
    }
  })

  it('returns [] on an empty collection', async () => {
    const repo = createFeedbackRepo(makeFakeFeedbackContainer([]))
    expect(await repo.listFeedback()).toEqual([])
  })
})

describe('feedback-repo — countFeedback', () => {
  it('returns the true total regardless of the list cap', async () => {
    const seed = Array.from({ length: 205 }, (_, i) => doc(`id-${i}`, `2026-06-18T00:00:00.${String(i).padStart(3, '0')}Z`))
    const repo = createFeedbackRepo(makeFakeFeedbackContainer(seed))
    expect(await repo.listFeedback({ limit: 200 })).toHaveLength(200)
    expect(await repo.countFeedback()).toBe(205)
  })

  it('returns 0 on an empty collection', async () => {
    const repo = createFeedbackRepo(makeFakeFeedbackContainer([]))
    expect(await repo.countFeedback()).toBe(0)
  })
})
