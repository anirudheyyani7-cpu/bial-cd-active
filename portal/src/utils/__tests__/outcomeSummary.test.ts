import { describe, it, expect } from 'vitest'
import { OUTCOME_COPY, outcomeSummary } from '../messageTypes'

/**
 * The turn engine's own bounded endings, in the transcript. Production, 2026-09-11: a build that
 * hit its request ceiling ended with the platform's banner saying "Your app is working — have a
 * look" under a transcript row saying "The build failed." — because `request_limit` had no arm
 * here and fell through to the status. Two sentences, one screen, opposite claims.
 */
describe('outcomeSummary — the bounded endings the turn engine names', () => {
  it('a build that hit its request ceiling is not announced as failed', () => {
    const text = outcomeSummary({ status: 'failed', reason: 'request_limit' })
    expect(text).toBe(OUTCOME_COPY.request_limit)
    expect(text).not.toMatch(/fail/i)
  })

  it('the wall clock ends with the same sentence — which bound fired is not something a citizen acts on', () => {
    expect(outcomeSummary({ status: 'failed', reason: 'wall_clock_deadline_exceeded' })).toBe(
      OUTCOME_COPY.request_limit,
    )
  })

  it('a model service that would not answer says so, and names no status, provider or token', () => {
    const text = outcomeSummary({ status: 'failed', reason: 'model_unavailable' })
    expect(text).toMatch(/could not get an answer/i)
    for (const leak of ['429', 'http', 'api', 'token', 'retry', 'foundry']) {
      expect(text.toLowerCase()).not.toContain(leak)
    }
  })

  it('an unlisted reason still takes the neutral fallback, never the token', () => {
    expect(outcomeSummary({ status: 'failed', reason: 'something_new' })).toBe('The build failed.')
  })
})
