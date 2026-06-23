import { describe, it, expect, vi } from 'vitest'
import { ensureIndexes, INDEX_SPECS } from '../ensure-indexes.js'

/** A fake collection that records every createIndex keyspec it was asked to build. */
function recordingCollection() {
  const calls = []
  return {
    calls,
    async createIndex(keyspec) {
      calls.push(keyspec)
      return `${Object.keys(keyspec).join('_')}_idx`
    },
  }
}

describe('ensureIndexes', () => {
  it('creates exactly the documented index specs on each wired collection', async () => {
    const conversations = recordingCollection()
    const messages = recordingCollection()
    const feedback = recordingCollection()
    const dataRecords = recordingCollection()

    const result = await ensureIndexes({ conversations, messages, feedback, dataRecords })

    expect(conversations.calls).toEqual(INDEX_SPECS.conversations)
    expect(messages.calls).toEqual(INDEX_SPECS.messages)
    expect(feedback.calls).toEqual(INDEX_SPECS.feedback)
    expect(dataRecords.calls).toEqual(INDEX_SPECS.dataRecords)
    const total =
      INDEX_SPECS.conversations.length +
      INDEX_SPECS.messages.length +
      INDEX_SPECS.feedback.length +
      INDEX_SPECS.dataRecords.length
    expect(result).toEqual({ created: total, failed: 0 })
  })

  it('data-records list/search reads have their tenant-scoped composite indexes', async () => {
    // list(appId) + search(appId, sort=createdAt) — the unfiltered, newest-first read.
    expect(INDEX_SPECS.dataRecords).toContainEqual({ appId: 1, createdAt: -1 })
    // list(appId, collection) — `collection` in the prefix before the sort key.
    expect(INDEX_SPECS.dataRecords).toContainEqual({ appId: 1, collection: 1, createdAt: -1 })
    // Every dataRecords index is `appId`-prefixed — tenant isolation rides the index.
    expect(INDEX_SPECS.dataRecords.every((s) => Object.keys(s)[0] === 'appId')).toBe(true)
  })

  it('covers both conversation list variants AND the full message ORDER BY', async () => {
    // Regression guard for the actual bug: the unfiltered (no-kind) list query
    // `find({username}).sort({updatedAt:-1})` needs its own 2-field index — the
    // `{username,kind,updatedAt}` index alone cannot serve it.
    expect(INDEX_SPECS.conversations).toContainEqual({ username: 1, updatedAt: -1 })
    expect(INDEX_SPECS.conversations).toContainEqual({ username: 1, kind: 1, updatedAt: -1 })
    // messages-repo sorts by {seq} ALONE — this Cosmos account serves only
    // single-field ORDER BY, so the index is the equality prefix + seq, with no
    // createdAt/_id (a multi-field ORDER BY 400s even with a matching index).
    expect(INDEX_SPECS.messages).toContainEqual({
      conversationId: 1,
      username: 1,
      seq: 1,
    })
    expect(INDEX_SPECS.messages.some((s) => 'createdAt' in s || '_id' in s)).toBe(false)
  })

  it('skips a collection key that is not wired on this deploy', async () => {
    const conversations = recordingCollection()
    const result = await ensureIndexes({ conversations }) // no messages/feedback handle

    expect(conversations.calls).toEqual(INDEX_SPECS.conversations)
    expect(result.failed).toBe(0)
    expect(result.created).toBe(INDEX_SPECS.conversations.length)
  })

  it('logs and continues when a single createIndex fails — boot is never aborted', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const conversations = {
      calls: [],
      async createIndex(keyspec) {
        // Fail only the first index; the second must still be attempted.
        if (this.calls.length === 0) {
          this.calls.push(keyspec)
          throw new Error('compound index unsupported on this tier')
        }
        this.calls.push(keyspec)
        return 'ok'
      },
    }

    const result = await ensureIndexes({ conversations })

    expect(conversations.calls).toHaveLength(INDEX_SPECS.conversations.length) // all attempted
    expect(result).toEqual({ created: INDEX_SPECS.conversations.length - 1, failed: 1 })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('retries a transient Cosmos RU throttle (16500) instead of failing the index', async () => {
    let attempts = 0
    const feedback = {
      calls: [],
      async createIndex(keyspec) {
        attempts += 1
        if (attempts === 1) {
          const err = new Error('TooManyRequests')
          err.code = 16500
          throw err
        }
        this.calls.push(keyspec)
        return 'ok'
      },
    }

    const result = await ensureIndexes({ feedback })

    expect(attempts).toBe(2) // first throttled, retried once, then succeeded
    expect(result).toEqual({ created: INDEX_SPECS.feedback.length, failed: 0 })
  })
})
