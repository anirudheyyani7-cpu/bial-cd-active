/**
 * The progress feed consumer: wraps a native `EventSource`, turning the SSE stream at
 * `/api/build-sessions/{id}/events` into dispatched, parsed envelopes.
 *
 * Uses `EventSource`, not the turn stream's fetch-and-parse idiom, for cookie-auth BY
 * CONSTRUCTION and free `Last-Event-ID` reconnect/replay — but replay covers only a
 * mid-stream drop, never a full page reload, which starts fresh with no replay; preview
 * continuity on reconnect instead comes from `getStatus` at the owning hook.
 *
 * Does NOT dedup by `seq` — envelopes dispatch in arrival order, replay overlap
 * included; idempotency is pinned at the hook, which upserts its store by `seq`.
 */
import { isRecord } from './apiError'
import { assertNever } from './assertNever'
import type {
  BuildError,
  ErrorSource,
  ProgressEnvelope,
} from './buildSessionTypes'

const BASE = '/api/build-sessions'

/** The non-retryable `EventSource` readyState (WHATWG): the connection is done and will not reconnect. */
const CLOSED = 2

/** The terminal SSE sentinel — byte-identical to the chat relay's, emitted once after the `ended` envelope. */
const DONE_SENTINEL = '[DONE]'

/**
 * The structural subset of a native `EventSource` this consumer uses. Declared as an
 * interface (not the DOM `EventSource`) so a test can drive it with a fake — no
 * `EventSource` mock exists in the repo, so this is net-new (a `FakeEventSource`
 * lives in `buildSessionMock.ts`).
 */
export interface EventSourceLike {
  readonly readyState: number
  onmessage: ((ev: MessageEvent) => void) | null
  onerror: ((ev: Event) => void) | null
  onopen: ((ev: Event) => void) | null
  close(): void
}

export type EventSourceFactory = (url: string) => EventSourceLike

/** Why the feed died. Both are terminal to THIS subscription (the hook decides the UI). */
export interface BuildFeedError {
  /**
   * `admission` — the stream never opened (`readyState === CLOSED` on the first
   * `error`): a 401/404 admission failure. `reconnect_exhausted` — the
   * stream opened, then dropped, and the bounded auto-reconnect gave up (network / 5xx).
   */
  kind: 'admission' | 'reconnect_exhausted'
  message: string
}

export interface BuildFeedHandlers {
  /** Every successfully-parsed envelope, in arrival order. Dedup is the hook's job (upsert by `seq`). */
  onEnvelope: (env: ProgressEnvelope) => void
  /** A terminal transport failure — surfaced so the feed never dies silently. */
  onError: (err: BuildFeedError) => void
  /** The connection opened (first byte). Optional — useful to clear a "connecting" banner. */
  onOpen?: () => void
}

export interface BuildFeedDeps {
  /** Swap the transport for a fake (tests) or a scripted mock (dev). Defaults to a real cookie-authed `EventSource`. */
  eventSourceFactory?: EventSourceFactory
  /**
   * How many consecutive auto-reconnect attempts to tolerate after the stream has
   * opened before failing closed. A build outlives a transient blip; it does not
   * outlive an endless reconnect loop against a dead relay.
   */
  maxReconnects?: number
}

export interface BuildFeedSubscription {
  /** Close the transport and stop dispatching. Idempotent. */
  close(): void
  /** The highest `seq` dispatched so far, or 0 before the first envelope. */
  lastSeq(): number
}

const DEFAULT_MAX_RECONNECTS = 5

/**
 * How long a connection must STAY open before the reconnect budget resets. Resetting on
 * `onopen` alone would let an open→drop flap loop forever without ever exhausting
 * `maxReconnects` (each flap re-arms the budget); only a connection that survives this
 * window counts as recovered.
 */
const STABILITY_RESET_MS = 10_000

const defaultEventSourceFactory: EventSourceFactory = (url) =>
  // `withCredentials` rides the HTTP-only session cookie. Referenced only
  // at runtime in the browser — jsdom has no `EventSource`, so tests always inject.
  new EventSource(url, { withCredentials: true })

// ─── parse-at-the-boundary: untrusted `data:` line → typed envelope ───────

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toErrorSource(value: unknown): ErrorSource {
  // `server` is the fail-safe default — an unknown source is treated as a runtime
  // error, never dropped, so the diagnostic still reaches the feed.
  return value === 'tsc' || value === 'next_build' || value === 'client' || value === 'server' ? value : 'server'
}

function toBuildError(value: unknown): BuildError {
  const doc = isRecord(value) ? value : {}
  return { source: toErrorSource(doc.source), title: asString(doc.title), cleaned_stack: asString(doc.cleaned_stack) }
}

/**
 * Narrow one untrusted parsed frame into a typed envelope, or `null` to DROP it
 * (an unknown `type`, a non-numeric `seq`, or a `preview_ready` with no url — a
 * frame we cannot act on). A dropped frame is the runtime half of the `assertNever`
 * compile guard: unknown variants never reach the dispatch `switch`.
 */
export function toProgressEnvelope(value: unknown): ProgressEnvelope | null {
  if (!isRecord(value)) return null
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return null
  const seq = value.seq

  switch (value.type) {
    case 'step':
      return {
        type: 'step',
        seq,
        name: asString(value.name),
        label: asString(value.label),
        state: value.state === 'ok' || value.state === 'failed' ? value.state : 'started',
        // Carry `hidden` through the parse, or the LIVE feed's `!env.hidden` filter is a
        // no-op (undefined) and read-only/housekeeping steps render live but not on reload.
        hidden: value.hidden === true,
      }
    case 'error':
      return { type: 'error', seq, source: toErrorSource(value.source), title: asString(value.title), cleaned_stack: asString(value.cleaned_stack) }
    case 'preview_ready':
      // A preview_ready with no url is unusable — drop it (the hook seeds from getStatus anyway).
      return typeof value.preview_url === 'string' && value.preview_url !== '' ? { type: 'preview_ready', seq, preview_url: value.preview_url } : null
    case 'preview_reconnecting':
      // The dev-server process crashed after framing. No payload; the hook routes it to the
      // distinct `reconnecting` flag (never a feed row, never the "building" spinner).
      return { type: 'preview_reconnecting', seq }
    case 'escalation':
      return { type: 'escalation', seq, reason: asString(value.reason), detail: asString(value.detail), last_error: value.last_error == null ? null : toBuildError(value.last_error) }
    case 'quota_exceeded':
      return { type: 'quota_exceeded', seq, limit: typeof value.limit === 'number' ? value.limit : 0, used: typeof value.used === 'number' ? value.used : 0, resets_at: asString(value.resets_at) }
    case 'ended':
      // Fail closed: an unrecognized terminal status is treated as `failed`, never lost — a
      // terminal envelope is load-bearing (it is what the hook derives ENDED/FAILED from).
      return { type: 'ended', seq, status: value.status === 'ended' ? 'ended' : 'failed', preview_url: typeof value.preview_url === 'string' ? value.preview_url : null, snapshot_committed: value.snapshot_committed === true, reason: asString(value.reason) }
    default:
      return null
  }
}

/**
 * True when an envelope is a terminal boundary that must close the feed. Written as
 * a TOTAL `switch` so adding an 8th member becomes a compile error right here
 * (`assertNever`) — forcing a deliberate terminal / non-terminal decision instead of
 * a silent default. Only `ended` is terminal (it is the single absorbing
 * envelope; `escalation` is informational, its terminal boundary is the `ended` that
 * follows; `preview_reconnecting` is a transient live-preview signal, never terminal).
 */
export function isTerminalEnvelope(env: ProgressEnvelope): boolean {
  switch (env.type) {
    case 'ended':
      return true
    case 'step':
    case 'error':
    case 'preview_ready':
    case 'preview_reconnecting':
    case 'escalation':
    case 'quota_exceeded':
      return false
    default:
      return assertNever(env)
  }
}

// ─── the subscription ─────────────────────────────────────────────────────────

/**
 * Open the SSE feed for `sessionId`, dispatching each envelope; `close()` tears the
 * transport down.
 * TERMINAL CLOSE IS LOAD-BEARING: an `EventSource` left open after a clean server
 * close AUTO-RECONNECTS (WHATWG), replaying `Last-Event-ID` into an already-torn-down
 * session — a zombie reconnect. So this closes explicitly on the typed `ended`
 * envelope and the `[DONE]` sentinel (special-cased ahead of the skip-malformed rule).
 */
export function subscribeBuildFeed(
  sessionId: string,
  handlers: BuildFeedHandlers,
  deps: BuildFeedDeps = {},
): BuildFeedSubscription {
  const factory = deps.eventSourceFactory ?? defaultEventSourceFactory
  const maxReconnects = deps.maxReconnects ?? DEFAULT_MAX_RECONNECTS
  const url = `${BASE}/${encodeURIComponent(sessionId)}/events`

  const source = factory(url)
  let closed = false
  let reconnects = 0
  let seenSeq = 0
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null

  const cancelStabilityTimer = (): void => {
    if (stabilityTimer !== null) {
      clearTimeout(stabilityTimer)
      stabilityTimer = null
    }
  }

  const shutDown = (): void => {
    if (closed) return
    closed = true
    cancelStabilityTimer()
    source.close()
  }

  source.onopen = () => {
    if (closed) return
    // The budget resets only after the connection STAYS open for the stability window —
    // an open→drop flap cancels the timer (in `onerror`) and keeps counting toward
    // `maxReconnects` instead of re-arming the budget on every open.
    cancelStabilityTimer()
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null
      reconnects = 0
    }, STABILITY_RESET_MS)
    handlers.onOpen?.()
  }

  source.onmessage = (ev: MessageEvent) => {
    if (closed) return
    const data: unknown = ev.data
    if (typeof data !== 'string') return

    // Special-case the terminal sentinel AHEAD of the malformed-skip rule:
    // `[DONE]` is not JSON, so the parser would otherwise drop it and leave the feed
    // open to auto-reconnect against a dead session.
    if (data === DONE_SENTINEL) {
      shutDown()
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return // a torn/partial `data:` line — skip (parity with the chat relay's skip-malformed rule)
    }

    const env = toProgressEnvelope(parsed)
    if (!env) return // unknown `type` / unusable frame — drop defensively (the `assertNever` compile guard covers the rest)

    if (env.seq > seenSeq) seenSeq = env.seq
    handlers.onEnvelope(env)

    // A typed `ended` is terminal — close now so no zombie reconnect follows (even if
    // `[DONE]` never arrives).
    if (isTerminalEnvelope(env)) shutDown()
  }

  source.onerror = () => {
    if (closed) return
    cancelStabilityTimer() // a drop before the stability window keeps the flap counting

    // `error` cannot expose the HTTP status. Distinguish by readyState:
    //   CLOSED → the stream will NOT retry — a non-retryable admission failure (401/404 / wrong
    //            content-type). Fail closed and stop.
    //   CONNECTING / OPEN → a retryable drop (a transient network blip, whether on the initial
    //            connect or mid-stream): let the native auto-reconnect run, but BOUND it so a dead
    //            relay can't loop forever. (Do NOT treat a never-yet-opened CONNECTING blip as
    //            admission — EventSource will retry it, and a flaky first connect should self-heal.)
    if (source.readyState === CLOSED) {
      shutDown()
      handlers.onError({ kind: 'admission', message: 'The build activity feed could not be reached.' })
      return
    }

    reconnects += 1
    if (reconnects > maxReconnects) {
      shutDown()
      handlers.onError({ kind: 'reconnect_exhausted', message: 'Lost the build activity feed and could not reconnect.' })
    }
    // else: within budget — let `EventSource` retry with `Last-Event-ID`.
  }

  return {
    close: shutDown,
    lastSeq: () => seenSeq,
  }
}
