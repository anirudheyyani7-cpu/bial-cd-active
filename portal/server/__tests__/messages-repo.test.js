import { describe, it, expect } from 'vitest'
import { createMessagesRepo } from '../messages-repo.js'
import { makeFakeMessagesContainer } from './fakeMessagesCosmos.js'

const A = 'alice@bial.test'
const B = 'bob@bial.test'

const msg = (id, conversationId, username, seq, parts, extra = {}) => ({
  _id: id,
  conversationId,
  username,
  role: seq % 2 === 0 ? 'user' : 'assistant',
  schemaVersion: 1,
  parts,
  seq,
  createdAt: `2026-06-20T09:0${seq}:00.000Z`,
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

describe('messages-repo — insertMessage / listByConversation', () => {
  it('returns messages in seq order; a repeat insert of the same _id is a no-op success', async () => {
    const c = makeFakeMessagesContainer([])
    const repo = createMessagesRepo(c)
    await repo.insertMessage(msg('m2', 'conv', A, 2, [{ type: 'text', text: 'second' }]))
    await repo.insertMessage(msg('m0', 'conv', A, 0, [{ type: 'text', text: 'first' }]))
    await repo.insertMessage(msg('m1', 'conv', A, 1, [{ type: 'text', text: 'middle' }]))

    const dup = await repo.insertMessage(msg('m0', 'conv', A, 0, [{ type: 'text', text: 'first' }]))
    expect(dup.duplicate).toBe(true)
    expect(c._store.size).toBe(3) // no extra row

    const rows = await repo.listByConversation('conv', A)
    expect(rows.map((r) => r._id)).toEqual(['m0', 'm1', 'm2']) // seq order
  })

  it('isolates by conversationId AND username (cross-conversation + cross-user)', async () => {
    const c = makeFakeMessagesContainer([
      msg('m1', 'conv-a', A, 0, [{ type: 'text', text: 'a' }]),
      msg('m2', 'conv-b', A, 0, [{ type: 'text', text: 'b' }]),
      msg('m3', 'conv-a', B, 0, [{ type: 'text', text: 'bob' }]), // same conv id, other user
    ])
    const repo = createMessagesRepo(c)
    const rows = await repo.listByConversation('conv-a', A)
    expect(rows.map((r) => r._id)).toEqual(['m1']) // not m2 (other conv), not m3 (other user)
    expect(await repo.listByConversation('conv-a', 'nobody@bial.test')).toEqual([])
  })

  it('round-trips a mixed text + file-ref parts[] intact', async () => {
    const c = makeFakeMessagesContainer([])
    const repo = createMessagesRepo(c)
    const parts = [
      {
        type: 'file',
        attachmentId: 'att-1',
        key: 'att/alice@bial.test/att-1',
        kind: 'image',
        name: 'diagram.png',
        mediaType: 'image/png',
        size: 1234,
      },
      { type: 'text', text: 'what is this?' },
    ]
    await repo.insertMessage(msg('m1', 'conv', A, 0, parts))
    const [row] = await repo.listByConversation('conv', A)
    expect(row.parts).toEqual(parts) // file ref metadata + text preserved
    expect(row.schemaVersion).toBe(1)
  })

  it('deleteByConversation removes exactly that conversation messages', async () => {
    const c = makeFakeMessagesContainer([
      msg('m1', 'conv-a', A, 0, [{ type: 'text', text: 'a' }]),
      msg('m2', 'conv-a', A, 1, [{ type: 'text', text: 'a2' }]),
      msg('m3', 'conv-b', A, 0, [{ type: 'text', text: 'b' }]),
    ])
    const repo = createMessagesRepo(c)
    const res = await repo.deleteByConversation('conv-a', A)
    expect(res.deletedCount).toBe(2)
    expect(c._store.has('m3')).toBe(true) // other conversation untouched
  })

  it('retries a throttle (16500) then succeeds, but propagates a non-throttle error', async () => {
    const base = makeFakeMessagesContainer([])
    const okRepo = createMessagesRepo(throttleInsertOnce(base))
    await okRepo.insertMessage(msg('m1', 'conv', A, 0, [{ type: 'text', text: 'x' }]))
    expect(base._store.size).toBe(1)

    const boomRepo = createMessagesRepo({
      ...base,
      async insertOne() {
        throw new Error('boom')
      },
    })
    await expect(boomRepo.insertMessage(msg('m2', 'conv', A, 1, []))).rejects.toThrow('boom')
  })
})
