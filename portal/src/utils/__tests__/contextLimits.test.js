import { describe, it, expect, afterEach } from 'vitest'
import { getContextLimits, CONTEXT_SOFT_LIMIT, CONTEXT_HARD_LIMIT } from '../../hooks/useClaudeAPI.js'

function storeUser(limits) {
  localStorage.setItem('bial_user', JSON.stringify({ username: 'u', ...(limits && { limits }) }))
}

describe('getContextLimits', () => {
  afterEach(() => localStorage.clear())

  it('falls back to the default constants when there is no stored user', () => {
    expect(getContextLimits()).toEqual({ soft: CONTEXT_SOFT_LIMIT, hard: CONTEXT_HARD_LIMIT })
  })

  it('falls back to defaults when the stored user carries no limits', () => {
    storeUser(null)
    expect(getContextLimits()).toEqual({ soft: CONTEXT_SOFT_LIMIT, hard: CONTEXT_HARD_LIMIT })
  })

  it('uses per-user overrides when present', () => {
    storeUser({ contextSoftLimit: 50_000, contextHardLimit: 120_000 })
    expect(getContextLimits()).toEqual({ soft: 50_000, hard: 120_000 })
  })

  it('forces soft strictly below hard', () => {
    storeUser({ contextSoftLimit: 120_000, contextHardLimit: 100_000 })
    const { soft, hard } = getContextLimits()
    expect(hard).toBe(100_000)
    expect(soft).toBeLessThan(100_000)
  })

  it('ignores an invalid override field (falls back to the default)', () => {
    storeUser({ contextHardLimit: -5 })
    expect(getContextLimits().hard).toBe(CONTEXT_HARD_LIMIT)
  })
})
