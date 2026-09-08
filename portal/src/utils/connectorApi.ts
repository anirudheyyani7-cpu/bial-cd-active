/**
 * The citizen's own connector access: what the platform can connect to, where this person
 * stands with each system, and the two writes that change it.
 *
 * Mirrors `marketplaceApi.ts` deliberately — `authFetch` + `readApiError` + a narrowing parse
 * of an `unknown` body, relative paths only, no base-URL resolution. The edge rewrites
 * `/api/*` to `/v1/*`, so the paths below are the browser-visible ones.
 *
 * NO `zod`, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. It is a hoisted transitive of
 * `@assistant-ui/react`, absent from `portal/package.json` and imported nowhere in `src/`, so
 * reaching for it here would adopt a runtime dependency and a parsing convention for the whole
 * portal as a side effect of one feature — the phantom-dependency hazard, with a schema library
 * attached.
 *
 * WHERE THIS PARSE IS STRICT, AND WHY IT DIFFERS FROM THE CATALOG'S. `marketplaceApi` drops an
 * unreadable row and renders the rest, because that list is a shared catalog of hundreds and one
 * bad app must not blank it for the org. This list is the WHOLE of what Integrations offers and it
 * has one entry today: dropping the only row would render "nothing is connected", which is a
 * different and false statement, and the state is what selects which sentence and which control a
 * row draws. So a row we cannot read is a contract break and throws — the dialog already has an
 * error-and-retry state, and it is the honest one.
 */
import { ApiError, isRecord, optionalString, readApiError } from './apiError'
import { authFetch } from './api'
import type { AuthFetchDeps } from './api'

/**
 * Which of the four person states this citizen is in for one connector, mirroring the server's
 * `ConnectorPersonState`. Person state 5 (`withdrawn`) is not in this pass — there is no enum
 * member behind it and nothing that could set it, so it is not spelled here either.
 */
export type ConnectorState = 'neverAsked' | 'pending' | 'approved' | 'declined'

/**
 * One ticked line of the ask panel's `WHAT AN APPROVAL GIVES YOU` box.
 *
 * TWO FIELDS, NOT ONE SENTENCE, because the lead is bold markup against the body's grey. A
 * pre-joined string would make the browser guess the split at the first full stop, and the
 * server's own third-person set has a body that starts lowercase mid-sentence on purpose.
 */
export interface ConsentLine {
  lead: string
  body: string
}

/**
 * One connector as the asking person sees it.
 *
 * Fields outside the caller's own state are `null`, by the server's design: `approvedByName` on a
 * declined row would be a second answer to "who decided".
 *
 * EVERY NAME FIELD IS NULLABLE, AND `null` DOES NOT MEAN "LOOK UP THE EMAIL". The server already
 * substitutes the decider's email when their display name is unset, so a present decider always
 * arrives with a usable handle. `null` means there is NO decider to name — nobody has decided, or
 * the administrator who did has since been deleted. A second fallback in the browser would invent
 * a name for a decision that has none.
 */
export interface ConnectorEntry {
  /** The stored `connector_key`. Stable, lowercase, and never rendered — `displayName` is. */
  key: string
  displayName: string
  subtitle: string
  /**
   * The whole sentence the ask panel sets under its title — what this system holds, and that one
   * administrator answers once for you. NOT `subtitle`, which is the row's four-word label; the
   * panel cannot derive either from the other, so both travel.
   */
  askSubtitle: string
  /**
   * The three promises an approval makes, in board order. THEY COME OFF THE WIRE SO THE PANEL
   * STAYS A RENDERER — a component that spelled one connector's dataset facts would make "add a
   * second connector" a component change rather than a registry entry.
   */
  consentLinesRequester: readonly ConsentLine[]
  state: ConnectorState
  /** `pending` only. Carries the time of day: the row reads `Asked 5 Sep, 08:30 · …`. */
  askedAt: string | null
  /** `approved` only. */
  approvedAt: string | null
  approvedByName: string | null
  /**
   * `approved` only: how many of this person's own projects have the connector switched on.
   * `null` — not `0` — in every other state, because "we did not count" and "none" are different
   * answers and only one of them belongs on a row with no access.
   */
  onProjectCount: number | null
  /** `declined` only. */
  decidedAt: string | null
  decidedByName: string | null
  /** `declined` only: the administrator's own words, rendered as plain text and never markdown. */
  decisionRemarks: string | null
}

/** A required wire field. Missing means the server broke its own contract, not "absent value". */
function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(`The server sent a connector we could not read (${field}).`, 500)
  }
  return value
}

/**
 * The state, or a throw. NOT a fallback to `neverAsked`: that would put a `Request access` button
 * in front of somebody the server has already answered, and their click would earn a 409.
 */
function readState(value: unknown): ConnectorState {
  if (value === 'neverAsked' || value === 'pending' || value === 'approved' || value === 'declined') {
    return value
  }
  throw new ApiError('The server sent a connector state this app does not recognise.', 500)
}

/**
 * The consent lines, or a throw — the module's strict half, not the catalog's forgiving one.
 *
 * AN EMPTY ARRAY IS A BREAK TOO. This is the copy that tells somebody what they are consenting
 * to before they ask for it; a connector that promises nothing is not a thinner panel, it is a
 * consent box with a heading and no consent under it. Dropping a malformed LINE would be worse
 * still — the citizen would read two of three promises with nothing on screen admitting the
 * third went missing. Both cases land in the dialog's error-and-retry state, which is honest.
 */
function readConsentLines(value: unknown): readonly ConsentLine[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(
      'The server sent a connector we could not read (consentLinesRequester).',
      500,
    )
  }
  return value.map((line: unknown) => {
    const row = isRecord(line) ? line : {}
    return {
      lead: readString(row.lead, 'consentLinesRequester.lead'),
      body: readString(row.body, 'consentLinesRequester.body'),
    }
  })
}

/** A count that is genuinely absent stays absent; anything unreadable is treated the same way. */
function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null
}

function toEntry(value: unknown): ConnectorEntry {
  const row = isRecord(value) ? value : {}
  return {
    key: readString(row.key, 'key'),
    displayName: readString(row.displayName, 'displayName'),
    // Not required: a connector with no one-line description renders a row with no subtitle,
    // which is a thinner row rather than an unreadable one.
    subtitle: typeof row.subtitle === 'string' ? row.subtitle : '',
    // Required, unlike `subtitle` above: a row with no one-line label is a thinner row, but an
    // ask panel with no opening sentence is a panel that will not say what it is asking about.
    askSubtitle: readString(row.askSubtitle, 'askSubtitle'),
    consentLinesRequester: readConsentLines(row.consentLinesRequester),
    state: readState(row.state),
    askedAt: optionalString(row.askedAt),
    approvedAt: optionalString(row.approvedAt),
    approvedByName: optionalString(row.approvedByName),
    onProjectCount: optionalCount(row.onProjectCount),
    decidedAt: optionalString(row.decidedAt),
    decidedByName: optionalString(row.decidedByName),
    decisionRemarks: optionalString(row.decisionRemarks),
  }
}

/** The envelope, unwrapped. A body with no `connectors` array is a break, not an empty list. */
function toEntries(body: unknown): ConnectorEntry[] {
  const doc = isRecord(body) ? body : {}
  if (!Array.isArray(doc.connectors)) {
    throw new ApiError('The server sent an integrations list we could not read.', 500)
  }
  return doc.connectors.map(toEntry)
}

const jsonOpts = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

/**
 * Every system this platform can connect to, and where you stand with each one.
 *
 * One entry per catalogue connector, always — a connector you have never asked about comes back
 * as `neverAsked`, because this is the whole of what Integrations offers rather than a list of
 * your grants.
 */
export async function listConnectors(deps: AuthFetchDeps = {}): Promise<ConnectorEntry[]> {
  const res = await authFetch('/api/connectors', {}, deps)
  if (!res.ok) throw await readApiError(res, 'Failed to load your integrations')
  return toEntries(await res.json())
}

/**
 * Ask an administrator for access to one connector, for yourself.
 *
 * `remarks` is required, 5 to 50 words by the shared rule in `utils/words.ts`. Refused with a 409
 * (`already_pending` / `already_decided`) if you are already waiting or have already been
 * answered; the message the server sends is the one to show.
 */
export async function requestConnectorAccess(
  connectorKey: string,
  remarks: string,
  deps: AuthFetchDeps = {},
): Promise<ConnectorEntry> {
  const res = await authFetch(
    `/api/connectors/${encodeURIComponent(connectorKey)}/request`,
    jsonOpts('POST', { remarks }),
    deps,
  )
  if (!res.ok) throw await readApiError(res, 'Failed to ask for access')
  return toEntry(await res.json())
}

/**
 * Withdraw your own waiting request. Only a request still waiting can be withdrawn — one an
 * administrator has already answered is refused with `409 nothing_pending` rather than silently
 * accepted. Returns the connector in its new state.
 */
export async function cancelConnectorRequest(
  connectorKey: string,
  deps: AuthFetchDeps = {},
): Promise<ConnectorEntry> {
  const res = await authFetch(
    `/api/connectors/${encodeURIComponent(connectorKey)}/cancel`,
    jsonOpts('POST'),
    deps,
  )
  if (!res.ok) throw await readApiError(res, 'Failed to cancel your request')
  return toEntry(await res.json())
}
