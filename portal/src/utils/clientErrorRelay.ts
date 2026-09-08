/**
 * The relay leg of the app's own client-error reporting. A generated app can 200 and still
 * die in the browser before it paints (bad hook order, null render, uncaught rejection) —
 * invisible to every SERVER-side signal, so "Build complete" can go out over a blank page.
 * Already captured by `window.onerror`/`unhandledrejection`/`console.*` (`error-capture.tsx`)
 * and posted to the framing portal; this is the listener. Reaches the user: nothing — it only
 * turns the build harness's verdict not-green and lets the agent act on it.
 *
 * TRUST BOUNDARY: the origin check on whether a message is even seen lives in `LivePreview`,
 * not here — this module only adds SHAPE validation, since the sender is unreviewed
 * agent-authored code running next to unreviewed npm.
 */

import { authFetch } from './api'
import type { AuthFetchDeps } from './api'
import { isRecord } from './apiError'

/** The postMessage discriminator the app's capture component stamps on every report. */
const CLIENT_ERROR_TYPE = 'bial:client-error'

/* Mirrors the server's own caps (`CLIENT_ERROR_*_MAX_CHARS` in
 * `backend/src/api/v1/build_sessions/schemas.py`). Kept in step by value, not by import — there
 * is no shared-constants mechanism across Python and TypeScript in this repo. */
const MAX_SOURCE = 64
const MAX_TITLE = 1000
const MAX_STACK = 20000

/**
 * How many reports one page may relay before it stops talking. A crash loop is the ORDINARY
 * shape here — React can re-throw hundreds of times a second, and a server-side cap alone
 * still means hundreds of requests/sec from the user's own browser; first few reports carry
 * the fault, rest are copies. Counted per FRAMED APP, not per tab, so a new project or a
 * rebuild starts fresh — else one bad build silences reporting for every later app.
 */
/* NB: the server keeps its own, LARGER cap under the same name
 * (`MAX_REPORTS_PER_APP = 10` in `backend/src/services/orchestrator/client_errors.py`). They are
 * not meant to match — this one bounds requests LEAVING the browser, that one bounds reports the
 * store KEEPS — and the client cap is the smaller of the two on purpose, so the throttle bites
 * before the server has to start refusing. */
export const MAX_REPORTS_PER_APP = 8

/** How many distinct scopes one relay tracks before it starts forgetting the oldest. */
const MAX_TRACKED_SCOPES = 8

/** A report as the app sends it, once we have decided it is one. */
export interface ClientErrorPayload {
  source: string
  title: string
  stack: string
}

/**
 * Is this inbound frame message a client-error report, and what does it say?
 *
 * Field-by-field narrowing, not a cast: the payload is authored by code inside the generated app,
 * so "it arrived from the right origin" says nothing about its shape. A message that is not a
 * report — or a report with no title, which is nothing to act on — returns null and is dropped.
 */
export function asClientErrorPayload(data: unknown): ClientErrorPayload | null {
  // `isRecord` rather than a hand-rolled `typeof === 'object'` check: it also excludes arrays,
  // which the naive form lets through as a record with numeric keys.
  if (!isRecord(data)) return null
  const record = data
  if (record.type !== CLIENT_ERROR_TYPE) return null
  const title = typeof record.title === 'string' ? record.title : ''
  if (title === '') return null
  return {
    // Capped HERE, not left to the server's own `max_length`. Every one of these strings is
    // written by code inside the generated app, and a server-side cap only rejects the body
    // AFTER it has been buffered — so an app that wanted to could drive the citizen's own
    // authenticated browser into posting arbitrarily large bodies at the control plane. The
    // limits mirror the server's; anything past them is noise in a diagnostic anyway.
    source: (typeof record.source === 'string' ? record.source : 'unknown').slice(0, MAX_SOURCE),
    title: title.slice(0, MAX_TITLE),
    // Absent on the `console.error` / `console.warn` arms, which are the commonest reports of
    // all — an empty stack is a normal report, not a malformed one.
    stack: (typeof record.stack === 'string' ? record.stack : '').slice(0, MAX_STACK),
  }
}

/**
 * Make a relay: `relay` runs per frame message; `reset` starts a fresh budget per turn.
 *
 * Budget is PER TURN not per page — the scope key (framed url) is stable across repair
 * turns, so a page-lifetime counter would go silent forever after 8 crashes. Counted PER
 * SCOPE, not a last-seen pointer, so flapping between two apps can't bypass the cap. Errors
 * are SWALLOWED by requirement — a failed report must cost the citizen nothing, ever.
 */
export function makeClientErrorRelay(deps: AuthFetchDeps = {}) {
  let sentByScope = new Map<string, number>()

  async function relay(projectId: string, appScope: string, data: unknown): Promise<void> {
    const payload = asClientErrorPayload(data)
    if (payload === null) return
    const sent = sentByScope.get(appScope) ?? 0
    if (sent >= MAX_REPORTS_PER_APP) return
    sentByScope.set(appScope, sent + 1)
    // Bounded: a page that framed many apps must not accumulate a counter per app forever.
    // Insertion-ordered, so the first key is the least recently FIRST-seen.
    if (sentByScope.size > MAX_TRACKED_SCOPES) {
      const oldest = sentByScope.keys().next().value
      if (oldest !== undefined) sentByScope.delete(oldest)
    }
    try {
      await authFetch(
        `/api/build-sessions/projects/${encodeURIComponent(projectId)}/client-error`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        deps,
      )
    } catch {
      // See the note above: a diagnostic about a broken app may not become a second failure.
    }
  }

  /** Start a fresh budget. Called when a turn begins — see the per-turn note above. */
  function reset(): void {
    sentByScope = new Map()
  }

  return { relay, reset }
}
