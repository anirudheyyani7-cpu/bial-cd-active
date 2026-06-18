import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveUserLimits,
  validateLimitsPatch,
  defaultLimits,
  MODEL_CONTEXT_WINDOW,
  DEFAULT_DAILY_TOKEN_LIMIT,
  DEFAULT_CONTEXT_SOFT_LIMIT,
  DEFAULT_CONTEXT_HARD_LIMIT,
} from '../limits.js'

// Small, distinct defaults so an override vs default is unambiguous.
const DEFAULTS = { dailyTokenLimit: 1000, contextSoftLimit: 100, contextHardLimit: 200 }

describe('defaultLimits', () => {
  const saved = process.env.DAILY_TOKEN_LIMIT
  afterEach(() => {
    if (saved === undefined) delete process.env.DAILY_TOKEN_LIMIT
    else process.env.DAILY_TOKEN_LIMIT = saved
  })

  it('uses the standard-plan constants when DAILY_TOKEN_LIMIT is unset', () => {
    delete process.env.DAILY_TOKEN_LIMIT
    expect(defaultLimits()).toEqual({
      dailyTokenLimit: DEFAULT_DAILY_TOKEN_LIMIT,
      contextSoftLimit: DEFAULT_CONTEXT_SOFT_LIMIT,
      contextHardLimit: DEFAULT_CONTEXT_HARD_LIMIT,
    })
  })

  it('reads a positive DAILY_TOKEN_LIMIT env', () => {
    process.env.DAILY_TOKEN_LIMIT = '500000'
    expect(defaultLimits().dailyTokenLimit).toBe(500000)
  })

  it('falls back to the constant when the env is invalid/non-positive', () => {
    process.env.DAILY_TOKEN_LIMIT = '0'
    expect(defaultLimits().dailyTokenLimit).toBe(DEFAULT_DAILY_TOKEN_LIMIT)
    process.env.DAILY_TOKEN_LIMIT = 'abc'
    expect(defaultLimits().dailyTokenLimit).toBe(DEFAULT_DAILY_TOKEN_LIMIT)
  })
})

describe('resolveUserLimits', () => {
  it('null / empty user → the defaults verbatim', () => {
    expect(resolveUserLimits(null, DEFAULTS)).toEqual(DEFAULTS)
    expect(resolveUserLimits({}, DEFAULTS)).toEqual(DEFAULTS)
    expect(resolveUserLimits({ limits: {} }, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('a valid override wins per field', () => {
    expect(resolveUserLimits({ limits: { dailyTokenLimit: 9000 } }, DEFAULTS).dailyTokenLimit).toBe(9000)
    expect(resolveUserLimits({ limits: { contextSoftLimit: 50 } }, DEFAULTS).contextSoftLimit).toBe(50)
  })

  it('an invalid override is ignored (falls back to the default)', () => {
    expect(resolveUserLimits({ limits: { dailyTokenLimit: -5 } }, DEFAULTS).dailyTokenLimit).toBe(1000)
    expect(resolveUserLimits({ limits: { dailyTokenLimit: 1.5 } }, DEFAULTS).dailyTokenLimit).toBe(1000)
    expect(resolveUserLimits({ limits: { dailyTokenLimit: '9000' } }, DEFAULTS).dailyTokenLimit).toBe(1000)
  })

  it('clamps the hard limit to the model window', () => {
    expect(resolveUserLimits({ limits: { contextHardLimit: 999_999 } }, DEFAULTS).contextHardLimit).toBe(
      MODEL_CONTEXT_WINDOW,
    )
  })

  it('forces soft strictly below hard when a lowered hard would collide with the default soft', () => {
    const r = resolveUserLimits({ limits: { contextHardLimit: 100 } }, DEFAULTS)
    expect(r.contextHardLimit).toBe(100)
    expect(r.contextSoftLimit).toBeLessThan(100)
  })
})

describe('validateLimitsPatch', () => {
  it('rejects a non-object body', () => {
    expect(validateLimitsPatch(null).ok).toBe(false)
    expect(validateLimitsPatch([]).ok).toBe(false)
  })

  it('rejects a body with no recognised limit fields', () => {
    expect(validateLimitsPatch({}).ok).toBe(false)
    expect(validateLimitsPatch({ bogus: 5 }).ok).toBe(false)
  })

  it('accepts a positive integer (set) and null (clear → default)', () => {
    expect(validateLimitsPatch({ dailyTokenLimit: 5000 })).toEqual({ ok: true, limits: { dailyTokenLimit: 5000 } })
    expect(validateLimitsPatch({ dailyTokenLimit: null })).toEqual({ ok: true, limits: { dailyTokenLimit: null } })
  })

  it('rejects non-positive / non-integer / string values', () => {
    expect(validateLimitsPatch({ dailyTokenLimit: 0 }).ok).toBe(false)
    expect(validateLimitsPatch({ dailyTokenLimit: -1 }).ok).toBe(false)
    expect(validateLimitsPatch({ dailyTokenLimit: 1.2 }).ok).toBe(false)
    expect(validateLimitsPatch({ dailyTokenLimit: '5' }).ok).toBe(false)
  })

  it('rejects a hard limit above the model window, accepts exactly the window', () => {
    expect(validateLimitsPatch({ contextHardLimit: MODEL_CONTEXT_WINDOW + 1 }).ok).toBe(false)
    expect(validateLimitsPatch({ contextHardLimit: MODEL_CONTEXT_WINDOW }).ok).toBe(true)
  })

  it('rejects soft >= hard when both are provided', () => {
    expect(validateLimitsPatch({ contextSoftLimit: 100, contextHardLimit: 100 }).ok).toBe(false)
    expect(validateLimitsPatch({ contextSoftLimit: 99, contextHardLimit: 100 }).ok).toBe(true)
  })
})
