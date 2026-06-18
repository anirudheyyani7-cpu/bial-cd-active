import { describe, it, expect, vi } from 'vitest'
import { withThrottleRetry, isThrottle } from '../mongo-retry.js'

/** A Cosmos-for-Mongo RU-throttle error (code 16500). */
function throttleErr() {
  const e = new Error('Request rate is large. More Request Units may be needed.')
  e.code = 16500
  return e
}

describe('withThrottleRetry', () => {
  it('retries a Cosmos RU-throttle (16500) and eventually succeeds', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw throttleErr()
      return 'ok'
    })
    await expect(withThrottleRetry(fn, { baseMs: 0 })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('gives up after the retry budget and rethrows the throttle error', async () => {
    const fn = vi.fn(async () => {
      throw throttleErr()
    })
    await expect(withThrottleRetry(fn, { retries: 2, baseMs: 0 })).rejects.toMatchObject({ code: 16500 })
    expect(fn).toHaveBeenCalledTimes(3) // initial attempt + 2 retries
  })

  it('does NOT retry a non-throttle error (e.g. duplicate key 11000)', async () => {
    const e = new Error('duplicate key')
    e.code = 11000
    const fn = vi.fn(async () => {
      throw e
    })
    await expect(withThrottleRetry(fn, { baseMs: 0 })).rejects.toThrow('duplicate key')
    expect(fn).toHaveBeenCalledTimes(1) // propagates immediately, no retry
  })

  it('honors a server RetryAfterMs hint when present', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 2) {
        const e = throttleErr()
        e.RetryAfterMs = 0
        throw e
      }
      return 'ok'
    })
    await expect(withThrottleRetry(fn, { baseMs: 0 })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('isThrottle', () => {
  it('recognizes code 16500 and codeName TooManyRequests, nothing else', () => {
    expect(isThrottle({ code: 16500 })).toBe(true)
    expect(isThrottle({ codeName: 'TooManyRequests' })).toBe(true)
    expect(isThrottle({ code: 11000 })).toBe(false)
    expect(isThrottle(null)).toBe(false)
    expect(isThrottle(undefined)).toBe(false)
  })
})
