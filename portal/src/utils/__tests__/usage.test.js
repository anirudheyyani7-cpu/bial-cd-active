import { describe, it, expect, vi } from 'vitest'
import { fetchUsageToday, notifyUsageChanged, onUsageChanged } from '../usage.js'

describe('fetchUsageToday', () => {
  it('returns null and does not fetch when there is no token', async () => {
    const fetchImpl = vi.fn()
    expect(await fetchUsageToday(fetchImpl, () => null)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns the usage body on a 200 and sends the Bearer token', async () => {
    const body = { used: 1234, limit: 1000000, remaining: 998766, resetsAt: '2026-06-18T18:30:00.000Z' }
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => body }))
    expect(await fetchUsageToday(fetchImpl, () => 'tok')).toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith('/api/usage/today', { headers: { Authorization: 'Bearer tok' } })
  })

  it('returns null on a non-ok response (e.g. 401 mid-logout) so the badge hides', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
    expect(await fetchUsageToday(fetchImpl, () => 'tok')).toBeNull()
  })
})

describe('usage change signal', () => {
  it('notifyUsageChanged invokes subscribed handlers; unsubscribe stops them', () => {
    const handler = vi.fn()
    const off = onUsageChanged(handler)
    notifyUsageChanged()
    expect(handler).toHaveBeenCalledTimes(1)
    off()
    notifyUsageChanged()
    expect(handler).toHaveBeenCalledTimes(1) // no longer subscribed
  })
})
