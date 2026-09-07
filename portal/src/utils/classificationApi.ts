/**
 * Typed client for the pre-publish classification review
 * (`/api/projects/:projectId/classification-review`), mirroring `deployApi.ts`: every call is
 * `fn(args, deps = {})`, responses arrive as `unknown` and pass through a narrower that throws
 * `ApiError` on a structurally-invalid body — never cast, never `any`.
 *
 * WHY THIS EXISTS: TWO VERBS, ONE SHAPE. `ensureClassificationReview` (POST) ensures a review
 * exists for the SAVED version (stored answers for an unchanged version, a fresh 202 `running`
 * run for a new one); `getClassificationReview` (GET) only reads, never starts a run, for the
 * dialog to poll. Both return the same body. TWO STAMPS, FILTER ON THE SECOND: `headSha` is the
 * version saved now, `reviewedSha` is the version the stored review examined — paint verdicts
 * only when they match, or a second tab's newer review fills in answers for a version this
 * dialog never named. THE BROWSER IS NEVER THE SOURCE: the publish request re-reads and merges
 * server-side, so nothing here can be used to skip or forge a review.
 */
import { ApiError, isRecord, optionalString, readApiError } from './apiError'
import { authFetch } from './api.js'
import type { AuthFetchDeps } from './projectApi'
import type { ClassificationKey } from './deployApi'

/**
 * The citizen-facing state of the review. `nothing_to_review` is the "no saved code
 * yet" state; `not_reviewed` means saved code with no review ever claimed (a GET-only state —
 * the ensure-POST is what claims one); an aged-out running review arrives as `failed`
 * with the `review_abandoned` code, never as an immortal `running`.
 */
export type ClassificationReviewStatus =
  | 'nothing_to_review'
  | 'not_reviewed'
  | 'running'
  | 'complete'
  | 'failed'

/** `unanswered` is a real verdict, distinct from `no`: the review answers only
 *  where it has evidence, and an unanswered question is the citizen's alone to decide. */
export type ReviewVerdict = 'yes' | 'no' | 'unanswered'

/** One question's citizen-safe projection: the verdict and a plain-language reason.
 *  The reason is multi-line PROSE — render it in a whitespace-preserving plain element,
 *  never through the shared markdown renderer (it collapses single newlines). */
export interface QuestionReview {
  verdict: ReviewVerdict
  reason: string
}

/** The six questions, same keys as `DataClassificationAnswers` so the modal's answer
 *  state and the review line up key-for-key. */
export type ReviewVerdicts = Record<ClassificationKey, QuestionReview>

/** The server's 503 error code when object storage is unreachable — and so is
 *  publishing itself (the pipeline reads the same bundle), so nobody is stranded
 *  behind this refusal. Branch on this, never on the message text. */
export const STORAGE_UNAVAILABLE = 'storage_unavailable'

/**
 * What the dialog knows: the version on record, what the review said about it (or why
 * it could not say), and nothing an administrator sees that a citizen must not — the
 * server strips evidence locations before this body is built.
 */
export interface ClassificationReview {
  status: ClassificationReviewStatus
  /** The CURRENT saved version and when it was saved — the "version X, saved at Y"
   *  line the dialog leads with. Both null in the nothing-to-review state. */
  headSha: string | null
  savedAt: string | null
  /** The version the stored review examined. Filter on it — see the module comment. */
  reviewedSha: string | null
  /** Present on `complete`, and on `failed` (a Tier A scan floor when one stands, six
   *  unanswered questions otherwise). Null while running and in the no-review states. */
  verdicts: ReviewVerdicts | null
  /** The failure taxonomy, only when `status === 'failed'`: the stable machine bucket
   *  and the citizen sentence for it. Render the sentence — the copy is the server's. */
  failureCode: string | null
  failureMessage: string | null
  /** Whether asking again can help. The server has already AND-ed this with its
   *  per-version attempt cap — trust it, never recompute; absent reads as false. */
  retryable: boolean
}

function invalid(field: string): ApiError {
  return new ApiError(`The server sent a review we could not read (${field}).`, 500)
}

function readStatus(value: unknown): ClassificationReviewStatus {
  if (
    value === 'nothing_to_review' ||
    value === 'not_reviewed' ||
    value === 'running' ||
    value === 'complete' ||
    value === 'failed'
  ) {
    return value
  }
  throw invalid('status')
}

function readQuestion(value: unknown, field: string): QuestionReview {
  if (!isRecord(value)) throw invalid(field)
  const { verdict, reason } = value
  if (verdict !== 'yes' && verdict !== 'no' && verdict !== 'unanswered') {
    throw invalid(`${field}.verdict`)
  }
  if (typeof reason !== 'string') throw invalid(`${field}.reason`)
  return { verdict, reason }
}

/**
 * Built field-by-field from exactly `verdict` and `reason` per question — the same
 * discipline as the server's wire model, so nothing else a future payload carries can
 * ride along, and a missing question fails loudly instead of silently dropping.
 */
function readVerdicts(value: unknown): ReviewVerdicts | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw invalid('verdicts')
  return {
    credentialsSecrets: readQuestion(value.credentialsSecrets, 'credentialsSecrets'),
    healthData: readQuestion(value.healthData, 'healthData'),
    personalInformation: readQuestion(value.personalInformation, 'personalInformation'),
    financialData: readQuestion(value.financialData, 'financialData'),
    confidentialBusinessData: readQuestion(
      value.confidentialBusinessData,
      'confidentialBusinessData',
    ),
    publicData: readQuestion(value.publicData, 'publicData'),
  }
}

function toClassificationReview(body: unknown): ClassificationReview {
  if (!isRecord(body)) throw invalid('body')
  const status = readStatus(body.status)
  const failureMessage = optionalString(body.failureMessage)
  // A failed review with no citizen sentence is unrenderable — refuse it here rather
  // than showing an empty failure a citizen cannot act on.
  if (status === 'failed' && failureMessage === null) throw invalid('failureMessage')
  return {
    status,
    headSha: optionalString(body.headSha),
    savedAt: optionalString(body.savedAt),
    reviewedSha: optionalString(body.reviewedSha),
    verdicts: readVerdicts(body.verdicts),
    failureCode: optionalString(body.failureCode),
    failureMessage,
    // Fail closed: no server flag, no re-check affordance.
    retryable: body.retryable === true,
  }
}

/**
 * Ensure a review exists for the current saved version, and answer with the current
 * state. Opening the publish dialog calls this; a "Check again" after a retryable
 * failure calls it again (there is no separate retry verb). 200 and 202 both resolve —
 * the body's `status` says whether to poll. Throws `ApiError` otherwise, notably the
 * 503 with code `storage_unavailable` whose message is the citizen sentence to render.
 */
export async function ensureClassificationReview(
  projectId: string,
  deps: AuthFetchDeps = {},
): Promise<ClassificationReview> {
  const res = await authFetch(
    `/api/projects/${encodeURIComponent(projectId)}/classification-review`,
    { method: 'POST' },
    deps,
  )
  if (!res.ok) throw await readApiError(res, 'Failed to start the automatic check')
  return toClassificationReview(await res.json())
}

/** Read the current review state — what the dialog polls while a run is in flight.
 *  Never starts a run. */
export async function getClassificationReview(
  projectId: string,
  deps: AuthFetchDeps = {},
): Promise<ClassificationReview> {
  const res = await authFetch(
    `/api/projects/${encodeURIComponent(projectId)}/classification-review`,
    {},
    deps,
  )
  if (!res.ok) throw await readApiError(res, 'Failed to read the automatic check')
  return toClassificationReview(await res.json())
}

/**
 * The answer of record per question, mirroring the server's merge
 * (`backend/src/services/classification/merge.py`): either side may raise a flag, neither may
 * lower the other's — validated review evidence beats a developer No, developer knowledge beats
 * a review No, everything else is the developer's. Exists because scoring developer answers
 * alone once showed "0 — can publish automatically" before the server merged to 45 and routed
 * the app. Deliberately blind to two server-only disputes — can under-count, never unsafely.
 */
export function mergeWithReview<K extends string>(
  citizen: Partial<Record<K, boolean | null>>,
  verdicts: Partial<Record<K, { verdict: ReviewVerdict } | null>> | null,
  keys: readonly K[],
): Record<K, boolean | null> {
  const merged = {} as Record<K, boolean | null>
  for (const key of keys) {
    const own = citizen[key] ?? null
    // A review Yes is the only verdict that overrides; `no` and `unanswered` both hand the
    // question back to the developer, and so does a review that never landed.
    merged[key] = verdicts?.[key]?.verdict === 'yes' ? true : own
  }
  return merged
}
