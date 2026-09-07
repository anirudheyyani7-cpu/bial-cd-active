/**
 * The browser's half of the per-conversation guardrail.
 *
 * The hard boundary is the server's and is tested there
 * (`backend/tests/api/v1/conversations/test_context_gate.py`). What is testable HERE is the
 * warning: that it appears at the administrator's threshold and not one token before, that it
 * respects an override — and, since #194, that it derives NOTHING.
 *
 * ★ THE RULE THESE TESTS PIN IS A DIFFERENT RULE FROM THE ONE THEY REPLACE. This file used to
 * assert the arithmetic of a declared twin of the server's estimator: four characters to the
 * token, a flat nominal per image, another per document, a reserve on top. Every one of those
 * constants is deleted on both sides, so those assertions are not loosened here — they are gone,
 * and their absence is itself asserted at the bottom of this file. `contextState` is now handed
 * the token count the provider reported, and an unmeasured conversation is silent.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import * as contextLimits from '../contextLimits'
import {
  DEFAULT_CONTEXT_HARD,
  DEFAULT_CONTEXT_SOFT,
  contextState,
  getContextLimits,
} from '../contextLimits'

vi.mock('../auth', async () => {
  const actual = await vi.importActual<typeof import('../auth')>('../auth')
  return { ...actual, getStoredUser: vi.fn(() => null) }
})

const { getStoredUser } = await import('../auth')
const mockedUser = vi.mocked(getStoredUser)

/**
 * A stored profile carrying (or not carrying) limits.
 *
 * Cast through `unknown`: `getContextLimits` reads exactly one field off the profile, and the
 * rest of `UserProfile` is irrelevant to every assertion here. Spelling out six unrelated
 * fields per case would make the tests read as if those fields mattered.
 */
function signedInWith(limits: Record<string, unknown> | undefined) {
  const profile = limits === undefined ? {} : { limits }
  mockedUser.mockReturnValue(profile as unknown as ReturnType<typeof getStoredUser>)
}

beforeEach(() => signedInWith(undefined))
afterEach(() => vi.clearAllMocks())

describe('getContextLimits', () => {
  it('falls back to the defaults for a session that carries no limits', () => {
    expect(getContextLimits()).toEqual({ soft: DEFAULT_CONTEXT_SOFT, hard: DEFAULT_CONTEXT_HARD })
  })

  it('uses the administrator’s override when the profile carries one', () => {
    signedInWith({ contextSoftLimit: 40_000, contextHardLimit: 50_000 })
    expect(getContextLimits()).toEqual({ soft: 40_000, hard: 50_000 })
  })

  it('clamps a soft threshold that is not below the hard one', () => {
    // A warning that first fires AT the wall arrives in the same breath as the refusal, which
    // is the one moment it is no use to anybody.
    signedInWith({ contextSoftLimit: 90_000, contextHardLimit: 50_000 })
    expect(getContextLimits()).toEqual({ soft: 49_999, hard: 50_000 })
  })

  it.each([0, -1, 1.5, '80000', null])('ignores a non-positive-integer override (%s)', (bad) => {
    signedInWith({ contextSoftLimit: bad, contextHardLimit: bad })
    expect(getContextLimits()).toEqual({ soft: DEFAULT_CONTEXT_SOFT, hard: DEFAULT_CONTEXT_HARD })
  })
})

describe('contextState', () => {
  it('is silent for a conversation nobody has measured', () => {
    // ★ THE HONEST ANSWER TO "NO NUMBER", and the one that is not a guess. A chat with no
    // completed turn is neither empty nor full as far as the browser knows, so it says nothing.
    // Reading `null` as zero would be an assumption; reading it as full would shout at someone
    // who has typed one sentence.
    const state = contextState(null)
    expect(state.gettingLong).toBe(false)
    expect(state.message).toBeNull()
    expect(state.occupied).toBeNull()
  })

  it('is silent below the threshold', () => {
    const state = contextState(4_000)
    expect(state.gettingLong).toBe(false)
    expect(state.message).toBeNull()
  })

  it('fires AT the threshold and not one token before', () => {
    // ★ The boundary assertion. `>=` vs `>` is a one-character mutation and this is what
    // catches it; so is a threshold read from the wrong field.
    signedInWith({ contextSoftLimit: 10_000, contextHardLimit: 20_000 })
    expect(contextState(9_999).gettingLong).toBe(false)
    expect(contextState(10_000).gettingLong).toBe(true)
  })

  it('follows the administrator’s warn threshold rather than the default', () => {
    // The same measurement, two users: silent under the default, warned under a lowered one.
    expect(contextState(10_000).gettingLong).toBe(false)
    signedInWith({ contextSoftLimit: 9_000, contextHardLimit: 20_000 })
    expect(contextState(10_000).gettingLong).toBe(true)
  })

  it('reports the measurement it was handed, unchanged', () => {
    // ★ NOTHING IS ADDED TO IT — no reserve, no per-attachment charge, no rounding. It is the
    // provider's own count, and the server refuses on that same number, so a browser that
    // adjusted it would be describing a different conversation from the one that gets refused.
    signedInWith({ contextSoftLimit: 10_000, contextHardLimit: 20_000 })
    expect(contextState(12_345).occupied).toBe(12_345)
    expect(contextState(0).occupied).toBe(0)
    expect(contextState(0).gettingLong).toBe(false)
  })

  it('says what to do and that the work survives it', () => {
    // The only reason a citizen hesitates to start a new chat is the fear that the app goes
    // with the conversation. Without the second half the first half reads as a threat.
    signedInWith({ contextSoftLimit: 1, contextHardLimit: 20_000 })
    const message = contextState(10).message ?? ''
    expect(message).toContain('new chat')
    expect(message).toContain('stays exactly as it is')
    // And it names no number: "150,000 of 200,000" is not something anyone can act on.
    expect(message).not.toMatch(/\d/)
  })
})

describe('the estimator', () => {
  it('★ exports nothing that derives a token figure', () => {
    // ASSERT-ABSENCE, PAIRED WITH LIVENESS so it cannot false-green on a module that failed to
    // load. Each of these was half of a declared twin with the server's estimator, and the pair
    // was wrong together: a document read as 1,600 tokens against a real 153,342 (#194). The
    // module must not grow them back under new names either — anything that turns a transcript
    // into a number belongs to the provider now.
    for (const gone of [
      'CHARS_PER_TOKEN',
      'NOMINAL_BINARY_TOKENS',
      'NOMINAL_PDF_TOKENS',
      'PDF_MEDIA_TYPE',
      'estimateConversationTokens',
    ]) {
      expect(gone in contextLimits).toBe(false)
    }

    // Liveness: the module really loaded, and the two exports that survive are the ones the
    // admin panel and the warning need.
    expect(typeof contextLimits.contextState).toBe('function')
    expect(contextLimits.SYSTEM_PROMPT_RESERVE).toBe(8_000)
  })
})
