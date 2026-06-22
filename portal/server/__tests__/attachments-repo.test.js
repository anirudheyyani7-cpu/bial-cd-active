import { describe, it, expect } from 'vitest'
import { createAttachmentsRepo, AttachmentCapError, ATTACHMENT_TOTAL_CAP } from '../attachments-repo.js'
import { makeFakeObjectStore } from './fakeObjectStore.js'
import { makeFakeAttachmentUsageContainer } from './fakeAttachmentUsageCosmos.js'

const A = 'alice@bial.test'
const B = 'bob@bial.test'

const png = (n = 8) => Buffer.from(Array.from({ length: n }, (_, i) => i % 256))

function setup(initialUsage = []) {
  const objectStore = makeFakeObjectStore()
  const usage = makeFakeAttachmentUsageContainer(initialUsage)
  const repo = createAttachmentsRepo(objectStore, usage)
  return { objectStore, usage, repo }
}

describe('attachments-repo — putBytes quota race (carried bug, test-first)', () => {
  it('two concurrent near-cap reserves cannot BOTH pass (atomic conditional update)', async () => {
    const size = 4 * 1024 * 1024
    // Room for exactly ONE more `size` upload.
    const { repo, usage } = setup([{ _id: A, total: ATTACHMENT_TOTAL_CAP - size }])
    const put = () =>
      repo.putBytes({ attachmentId: 'x', username: A, mediaType: 'image/png', size, name: 'x.png', buffer: png() })

    const results = await Promise.allSettled([put(), put()])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const capped = results.filter((r) => r.status === 'rejected' && r.reason instanceof AttachmentCapError)
    expect(ok).toHaveLength(1) // exactly one reserved
    expect(capped).toHaveLength(1) // the other hit the cap
    expect(usage._get(A).total).toBe(ATTACHMENT_TOTAL_CAP) // no over-count
  })
})

describe('attachments-repo — putBytes / getBytes', () => {
  it('stores a byte-identical object under cap and increases the total by size', async () => {
    const { repo, usage, objectStore } = setup()
    const buffer = png(16)
    const ref = await repo.putBytes({
      attachmentId: 'att-1',
      username: A,
      mediaType: 'image/png',
      size: buffer.length,
      name: 'd.png',
      buffer,
    })
    expect(ref).toEqual({
      attachmentId: 'att-1',
      key: 'att/alice@bial.test/att-1',
      mediaType: 'image/png',
      size: buffer.length,
      name: 'd.png',
    })
    expect(objectStore._store.has('att/alice@bial.test/att-1')).toBe(true)
    expect(await repo.getBytes('att-1', A)).toEqual(buffer) // byte-identical
    expect(usage._get(A).total).toBe(buffer.length)
  })

  it('rejects an over-cap put: AttachmentCapError, no object, total unchanged', async () => {
    const size = 4 * 1024 * 1024
    const { repo, usage, objectStore } = setup([{ _id: A, total: ATTACHMENT_TOTAL_CAP - 1 }])
    await expect(
      repo.putBytes({ attachmentId: 'att-1', username: A, mediaType: 'image/png', size, name: 'x.png', buffer: png() }),
    ).rejects.toBeInstanceOf(AttachmentCapError)
    expect(objectStore._store.size).toBe(0) // nothing stored
    expect(usage._get(A).total).toBe(ATTACHMENT_TOTAL_CAP - 1) // no drift
  })

  it('compensates the total back when the object-store put fails after reserve', async () => {
    const usage = makeFakeAttachmentUsageContainer()
    const objectStore = {
      ...makeFakeObjectStore(),
      async put() {
        throw new Error('object store down')
      },
    }
    const repo = createAttachmentsRepo(objectStore, usage)
    await expect(
      repo.putBytes({ attachmentId: 'att-1', username: A, mediaType: 'image/png', size: 1000, name: 'x.png', buffer: png() }),
    ).rejects.toThrow('object store down')
    expect((usage._get(A)?.total) || 0).toBe(0) // reserve rolled back
  })
})

describe('attachments-repo — per-user key scoping', () => {
  it('user B cannot read user A object (username-derived key)', async () => {
    const { repo } = setup()
    const buffer = png()
    await repo.putBytes({ attachmentId: 'att-1', username: A, mediaType: 'image/png', size: buffer.length, name: 'a.png', buffer })
    // B requests the same attachmentId — the key is derived from B's username, a
    // different namespace, so the object is not found.
    await expect(repo.getBytes('att-1', B)).rejects.toThrow(/NoSuchKey/)
  })

  it('deleteBytes removes the owner object and decrements the total', async () => {
    const { repo, usage, objectStore } = setup()
    const buffer = png(2048)
    await repo.putBytes({ attachmentId: 'att-1', username: A, mediaType: 'image/png', size: buffer.length, name: 'a.png', buffer })
    await repo.deleteBytes('att-1', A, buffer.length)
    expect(objectStore._store.size).toBe(0)
    expect(usage._get(A).total).toBe(0)
  })
})

describe('attachments-repo — deleteByConversation', () => {
  it('deletes exactly the given conversation objects and decrements the total', async () => {
    const { repo, usage, objectStore } = setup()
    const b1 = png(1000)
    const b2 = png(2000)
    await repo.putBytes({ attachmentId: 'a1', username: A, mediaType: 'image/png', size: b1.length, name: '1.png', buffer: b1 })
    await repo.putBytes({ attachmentId: 'a2', username: A, mediaType: 'image/png', size: b2.length, name: '2.png', buffer: b2 })
    await repo.putBytes({ attachmentId: 'keep', username: A, mediaType: 'image/png', size: 500, name: 'k.png', buffer: png(500) })

    await repo.deleteByConversation(
      [
        { attachmentId: 'a1', size: b1.length },
        { attachmentId: 'a2', size: b2.length },
      ],
      A,
    )
    expect(objectStore._store.has('att/alice@bial.test/a1')).toBe(false)
    expect(objectStore._store.has('att/alice@bial.test/a2')).toBe(false)
    expect(objectStore._store.has('att/alice@bial.test/keep')).toBe(true) // untouched
    expect(usage._get(A).total).toBe(500) // only `keep` remains
  })
})

describe('attachments-repo — getTotal + throttle', () => {
  it('getTotal returns the running total, 0 on miss', async () => {
    const { repo } = setup([{ _id: A, total: 4242 }])
    expect(await repo.getTotal(A)).toBe(4242)
    expect(await repo.getTotal(B)).toBe(0)
  })

  it('retries a throttle (16500) on the conditional reserve', async () => {
    const objectStore = makeFakeObjectStore()
    const base = makeFakeAttachmentUsageContainer()
    let calls = 0
    const usage = {
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
    const repo = createAttachmentsRepo(objectStore, usage)
    const buffer = png()
    const ref = await repo.putBytes({ attachmentId: 'att-1', username: A, mediaType: 'image/png', size: buffer.length, name: 'a.png', buffer })
    expect(ref.attachmentId).toBe('att-1')
    expect(objectStore._store.size).toBe(1)
  })
})
