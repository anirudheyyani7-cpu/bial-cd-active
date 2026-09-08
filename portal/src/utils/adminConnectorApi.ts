/**
 * The administrator's connector queue: who has asked to reach a connector, and what was decided.
 *
 * THE SIBLING OF `connectorApi.ts`, NOT A SECOND COPY OF IT. That module answers "where do *I*
 * stand with this connector" and every statement behind it is scoped to the caller. This one is
 * the ONE connector surface that reads across users — every route behind it is super-admin-gated
 * — so the two are split exactly where the wire splits them, and no caller has to work out whose
 * rows it is holding.
 *
 * The conventions are that module's, on purpose: `authFetch` + `readApiError`, relative `/api/*`
 * paths (the edge rewrites them to `/v1/*`), a narrowing parse of an `unknown` body, and no
 * `zod` — it is a hoisted transitive of `@assistant-ui/react`, absent from `package.json`, so
 * reaching for it here would adopt a runtime dependency for the whole portal as a side effect of
 * one panel.
 *
 * THE PARSE IS STRICT, for the reason the citizen module's is. This is the screen an
 * administrator opens to find out what is waiting on them; a row quietly dropped for being
 * unreadable would leave a person waiting behind a queue that reads as caught up. A row we
 * cannot read is a contract break and throws — the panel has an error-and-retry state, and that
 * is the honest one.
 *
 * R18: nothing here names a connector. The key is a value, the display name rides the wire.
 */
import { ApiError, isRecord, optionalString, readApiError } from './apiError'
import { authFetch } from './api'
import type { AuthFetchDeps } from './api'

/**
 * Which table a listing asks for. `state` IS REQUIRED ON THE WIRE and there is no honest
 * default: it selects the rows *and* their order — `waiting` is oldest first (the person who has
 * waited longest is on top) and `decided` is newest decision first — so a caller that omitted it
 * would be asking for a queue with no answer to "in what order".
 *
 * A withdrawn request is in NEITHER: nobody is waiting on it and nobody decided it.
 */
export type ConnectorQueueState = 'waiting' | 'decided'

/**
 * A row's own status, mirroring the server's `ConnectorRequestStatus`. `cancelled` is a real
 * stored value that never crosses THIS wire — it is in neither listing — so it is not spelled
 * here either.
 */
export type ConnectorRequestStatus = 'pending' | 'approved' | 'declined'

/**
 * One request as the queue sees it — one shape for both tables, with the fields outside a row's
 * own status reading `null`.
 *
 * `displayName` IS NEVER NULL, AND A SECOND FALLBACK HERE WOULD BE A BUG. `users.display_name`
 * is nullable and the SERVER already substitutes the work email, in the one place that rule
 * lives. A browser-side `displayName || email` would be a second emitter of one substitution,
 * free to drift the day either side is edited.
 *
 * `usingItIn` IS `null` ON A WAITING OR DECLINED ROW AND `0` IS A REAL ANSWER — an approved
 * person who has not switched it on anywhere yet. The board draws an em dash for a decline,
 * which is a different statement from "none", so the two must not be folded together.
 */
export interface ConnectorRequestRow {
  id: string
  /** The person who asked. The queue is the one surface that reads across users, so this rides. */
  userId: string
  /** `users.display_name`, or the work email behind it. Never empty. */
  displayName: string
  /** The work email — the second line of the queue's person cell, in place of the board's
   *  `department`, which exists nowhere in this product and has no directory client behind it. */
  email: string
  /** The stored key. Stable, lowercase, never rendered — `connectorDisplayName` is. */
  connectorKey: string
  connectorDisplayName: string
  /** The citizen's own words, in full. Rendered untruncated, as plain text, never markdown. */
  requesterRemarks: string
  askedAt: string
  status: ConnectorRequestStatus
  /** The four decided-only fields. `null` on a waiting row. */
  decidedAt: string | null
  /**
   * WHY THE ID RIDES AND NOT JUST THE NAME: BIAL runs two super-admins, so `WHEN` may read
   * `you` only to the administrator who actually made that decision. The panel compares this
   * against the signed-in profile; the other administrator's rows carry their name.
   */
  decidedById: string | null
  /** The decider's name or email. `null` when the administrator who decided has since been
   *  deleted — a decision outlives its decider, and the row keeps its date unnamed. */
  decidedByName: string | null
  /** Written only on a decline. `null` on an approval is correct, not a missing write. */
  decisionRemarks: string | null
  /** `USING IT IN` — how many of THIS person's projects have THIS connector switched on. */
  usingItIn: number | null
}

/**
 * One page of one table.
 *
 * `truncated` IS NOT DECORATION: nothing bounds how many people may ask for a connector, the
 * server stops at 200, and a silent prefix would let a request wait forever behind a console
 * showing a caught-up screen.
 */
export interface ConnectorRequestPage {
  requests: ConnectorRequestRow[]
  truncated: boolean
}

/** A required wire field. Missing means the server broke its own contract, not "absent value". */
function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(`The server sent a request we could not read (${field}).`, 500)
  }
  return value
}

/**
 * The status, or a throw. NOT a fallback: a row whose status we guessed would be filed under the
 * wrong heading — a decision rendered as still waiting, or the reverse — on the one screen whose
 * whole job is to tell those two apart.
 */
function readStatus(value: unknown): ConnectorRequestStatus {
  if (value === 'pending' || value === 'approved' || value === 'declined') return value
  throw new ApiError('The server sent a request state this app does not recognise.', 500)
}

/**
 * `USING IT IN`, preserving the difference between "none" and "not asked".
 *
 * `0` SURVIVES AS `0`. It is a real answer — somebody approved who has not switched the
 * connector on in any project yet — and folding it to `null` would draw the declined row's em
 * dash over an approval.
 */
function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null
}

function toRow(value: unknown): ConnectorRequestRow {
  const row = isRecord(value) ? value : {}
  return {
    id: readString(row.id, 'id'),
    userId: readString(row.userId, 'userId'),
    displayName: readString(row.displayName, 'displayName'),
    email: readString(row.email, 'email'),
    connectorKey: readString(row.connectorKey, 'connectorKey'),
    connectorDisplayName: readString(row.connectorDisplayName, 'connectorDisplayName'),
    requesterRemarks: readString(row.requesterRemarks, 'requesterRemarks'),
    askedAt: readString(row.askedAt, 'askedAt'),
    status: readStatus(row.status),
    decidedAt: optionalString(row.decidedAt),
    decidedById: optionalString(row.decidedById),
    decidedByName: optionalString(row.decidedByName),
    decisionRemarks: optionalString(row.decisionRemarks),
    usingItIn: optionalCount(row.usingItIn),
  }
}

/**
 * One table of the queue.
 *
 * TWO CALLS RENDER THE SCREEN, one per table, because `state` selects the rows AND their order
 * and the two orders are opposites. `connector` narrows to one catalogue key and is refused with
 * `400 unknown_connector` if it is not one; `q` matches a person's name or work email,
 * case-insensitively, and is what bounds which 200 rows the cap returns.
 */
export async function listConnectorRequests(
  state: ConnectorQueueState,
  filters: { connector?: string | null; q?: string | null } = {},
  deps: AuthFetchDeps = {},
): Promise<ConnectorRequestPage> {
  const params = new URLSearchParams({ state })
  if (filters.connector) params.set('connector', filters.connector)
  if (filters.q) params.set('q', filters.q)
  const res = await authFetch(`/api/admin/connector-requests?${params.toString()}`, {}, deps)
  if (!res.ok) throw await readApiError(res, 'Failed to load the connector queue')
  const body: unknown = await res.json()
  const doc = isRecord(body) ? body : {}
  if (!Array.isArray(doc.requests)) {
    throw new ApiError('The server sent a connector queue we could not read.', 500)
  }
  return {
    requests: doc.requests.map(toRow),
    // Absent reads as "not truncated": the server defaults it to `false`, and treating a missing
    // flag as `true` would put a cap notice over a three-row queue.
    truncated: doc.truncated === true,
  }
}

/**
 * How many people are waiting on a decision — the Integrations tab badge's only source.
 *
 * A DEDICATED ROUTE RATHER THAN `requests.length` OFF THE LISTING: that listing projects up to
 * 200 rows, joins `users` twice and counts every approved person's enabled projects, and a badge
 * reading it would pay all of that — and pay MORE as the queue it reports on grows, which is
 * exactly backwards. An empty queue answers `0`, never a 404.
 */
export async function fetchWaitingConnectorCount(deps: AuthFetchDeps = {}): Promise<number> {
  const res = await authFetch('/api/admin/connector-requests/counts', {}, deps)
  if (!res.ok) throw await readApiError(res, 'Failed to load the waiting count')
  const body: unknown = await res.json()
  const doc = isRecord(body) ? body : {}
  if (typeof doc.waiting !== 'number' || !Number.isFinite(doc.waiting)) {
    throw new ApiError('The server sent a waiting count we could not read.', 500)
  }
  return Math.max(0, Math.trunc(doc.waiting))
}
