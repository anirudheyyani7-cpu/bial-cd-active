import { describe, it, expect, vi } from 'vitest'
import * as approvalApi from '../approvalApi'
import { withdrawSubmission } from '../approvalApi'
import { ApiError } from '../apiError'

// A real WHATWG Response so `res.ok`/`res.status`/`res.json()` behave exactly as production
// fetch would — no module mocking, since the file's whole value is the unknown→narrowed
// parsing, so the real narrowers must run in CI.
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const fetchReturning = (status: number, body: unknown) =>
  vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(status, body))

// authFetch deps injection — no real token/network. getToken returns null: the
// cookie-session model carries no client bearer token.
const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, getToken: () => null, refresh: async () => false })

// --- the retired submit verb ---------------------------------------------------------

describe('the citizen submit verb is gone', () => {
  /**
   * A GUARD, not a deletion. `/api/apps/:id/submit` was retired: only one route into the
   * review queue is allowed now, through the publish request, which attaches both answer
   * sets and the citizen's explanation — the retired route attached none of that. Deleting
   * this coverage is what an implementer meeting a red suite reaches for first, and it would
   * leave nothing stopping the second way in from being quietly re-added.
   */
  it('exports no submitForReview — publishing is the only way into the queue', () => {
    expect('submitForReview' in approvalApi).toBe(false)
    // Belt and braces: a re-export resolving to undefined must fail this too, not just the key check.
    expect((approvalApi as Record<string, unknown>).submitForReview).toBeUndefined()
  })

  it('exports no SubmitResult narrowing helper surface either', () => {
    // The type is compile-time only; a runtime guard can only pin that no value-level survivor remains.
    expect(Object.keys(approvalApi).filter((k) => /submit/i.test(k))).toEqual([])
  })
})

describe('withdrawSubmission', () => {
  it('POSTs /api/apps/:id/withdraw with NO body and returns the narrowed result', async () => {
    const fetchImpl = fetchReturning(200, { appId: 'app-1', status: 'draft' })
    const result = await withdrawSubmission('app-1', deps(fetchImpl))
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/apps/app-1/withdraw')
    expect(init?.method).toBe('POST')
    // The server knows which submission is pending — a body would let a client name one.
    expect(init?.body).toBeUndefined()
    expect(result).toEqual({ appId: 'app-1', status: 'draft' })
  })

  it('URL-encodes an appId with unsafe characters', async () => {
    const fetchImpl = fetchReturning(200, { appId: 'a/b', status: 'draft' })
    await withdrawSubmission('a/b', deps(fetchImpl))
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/apps/a%2Fb/withdraw')
  })

  it('surfaces the server 409 copy verbatim when it is no longer pending', async () => {
    // An administrator decided it first. The server's sentence says so; the control
    // renders it rather than string-matching its way to a guess.
    const fetchImpl = fetchReturning(409, {
      error: { message: 'Only a submission that is waiting for review can be withdrawn.' },
    })
    const err = await withdrawSubmission('app-1', deps(fetchImpl)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).message).toContain('waiting for review')
  })

  it('throws rather than trust an unknown status literal in the withdraw response', async () => {
    const fetchImpl = fetchReturning(200, { appId: 'app-1', status: 'evaporated' })
    const err = await withdrawSubmission('app-1', deps(fetchImpl)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
  })

  it('throws on a missing appId rather than coerce it to ""', async () => {
    const fetchImpl = fetchReturning(200, { status: 'draft' })
    const err = await withdrawSubmission('app-1', deps(fetchImpl)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toMatch(/could not read/i)
  })
})

describe('the app-scoped status read is gone', () => {
  /**
   * A GUARD, not deleted coverage. `getApprovalStatus` served the approval card the canvas's
   * `Removals` board took out; the SERVER route is untouched, but the publish/review surfaces
   * now read the lifecycle off the PROJECT-scoped deploy status instead — one shared poll
   * lifetime, so re-adding a second app-scoped poll here is precisely what would break that.
   * `toAppStatus`'s narrowing behaviors this file lost a caller for are still exercised
   * through `withdrawSubmission`, in the block above.
   */
  it('exports no app-scoped status read — the lifecycle comes off the deploy poll', () => {
    expect('getApprovalStatus' in approvalApi).toBe(false)
    expect((approvalApi as Record<string, unknown>).getApprovalStatus).toBeUndefined()
    // Paired with a liveness assertion so the absences above cannot false-green on an
    // empty module namespace.
    expect(typeof (approvalApi as Record<string, unknown>).withdrawSubmission).toBe('function')
  })
})
