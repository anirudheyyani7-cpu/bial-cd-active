/**
 * Typed client for the owner-facing approval flow (`POST /api/apps/:appId/withdraw`), mirroring
 * `projectApi.ts`: every call is `fn(args, deps = {})` forwarding `deps` to `authFetch`, and every
 * response arrives as `unknown` through a narrower that throws `ApiError` — never cast, never `any`.
 *
 * WITHDRAW IS THE ONLY VERB HERE, and both absences are deliberate. There is no submit verb: an
 * app enters the queue through the publish request alone. There is no app-scoped
 * `getApprovalStatus` either — the publish and review surfaces read the lifecycle off the
 * PROJECT-scoped deploy status instead, so both share one poll lifetime and cannot end up telling
 * the citizen two different things. Both server routes are untouched; `approvalApi.test.ts` guards
 * the two absences rather than having deleted the coverage. */
import { ApiError, isRecord, readApiError } from './apiError'
import { authFetch } from './api'
import type { AppStatus, AuthFetchDeps } from './projectApi'

/** What a successful withdrawal left behind (POST /apps/:id/withdraw): the app, back at
 *  draft. The queue item is REMOVED, not replaced — an administrator mid-review sees it
 *  disappear rather than change underneath them. */
export interface WithdrawResult {
  appId: string
  status: AppStatus
}

function toAppStatus(value: unknown): AppStatus {
  if (
    value === 'draft' ||
    value === 'pending' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'disabled'
  ) {
    return value
  }
  // Unknown variants are dropped HERE, at the boundary, so the control's
  // `assertNever` switch stays unreached in practice (fail-first).
  throw new ApiError('The server returned an app status we could not read.', 500)
}

function toWithdrawResult(value: unknown): WithdrawResult {
  if (!isRecord(value) || typeof value.appId !== 'string' || value.appId === '') {
    throw new ApiError('The server returned an app we could not read.', 500)
  }
  return { appId: value.appId, status: toAppStatus(value.status) }
}

/**
 * Pull the owner's own PENDING submission back out of the queue — no body; the
 * server knows which submission is pending. Clears the pin, the declaration and the
 * lineage, and leaves the app at `draft`; the approved pin and the immutable submission
 * blob survive. A 409 means it was not pending any more (an administrator got there
 * first), and carries the server's own copy.
 */
export async function withdrawSubmission(
  appId: string,
  deps: AuthFetchDeps = {},
): Promise<WithdrawResult> {
  const res = await authFetch(
    `/api/apps/${encodeURIComponent(appId)}/withdraw`,
    { method: 'POST' },
    deps,
  )
  if (!res.ok) throw await readApiError(res, 'Failed to withdraw the submission')
  return toWithdrawResult(await res.json())
}
