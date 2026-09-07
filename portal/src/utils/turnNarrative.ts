/**
 * Turn frames → the progress-envelope shape, plus what the surface asks ABOUT a turn. A build is
 * a Write turn now, so its narrative arrives as `step`/`diagnostic`/`quota` turn frames instead of
 * progress envelopes; ADAPTING rather than rewriting is deliberate — one mapping is how the two
 * transports agree by construction, not by discipline.
 *
 * THE ENVELOPES HAVE ONE READER: the legacy build-session feed and the two questions the surface
 * asks of a turn — `turnPhase` (app pane) and `atLimitSendState` (composer) — both live here so
 * neither caller has to learn this module's vocabulary. The one place the two vocabularies
 * genuinely differ (`diagnostic` → `error`) is explained at its mapping below.
 */
import type { StepItem } from './turnStreamApi'
import type {
  BuildSessionStatus,
  ErrorEvent,
  ErrorSource,
  FeedEnvelope,
  QuotaExceededEvent,
  StepEvent,
} from './buildSessionTypes'

export interface TurnNarrative {
  /** Live steps, keyed by tool-call id so the `finished` frame REPLACES its `started` one. */
  steps: Record<string, StepItem>
  /** Structurally a `DiagnosticFrame`. The citizen-facing pair is part of the shape ON
   *  PURPOSE: this mapping is the seam a new field disappears at — everything not named
   *  below is dropped silently, with a green typecheck, because the target `ErrorEvent`
   *  fields are optional. Listing them here makes omitting them a compile error. */
  diagnostics: {
    source: string
    userMessage: string
    userAction: string
  }[]
  quota: { limit: number; used: number; resetsAt: string } | null
  workspace: { state: 'preparing' | 'ready' | 'unavailable'; message: string | null } | null
  preview: { url: string | null; state: 'ready' | 'reconnecting' | null }
}

const ERROR_SOURCES = new Set(['tsc', 'next_build', 'server', 'client'])

/**
 * The synthetic `seq` space. Envelopes are deduped and ordered BY SEQ, and turn frames carry
 * their own seq numbering that these items do not preserve — so order is imposed here, by
 * emission order, with diagnostics and the quota notice after the steps they followed.
 */
export function narrativeEnvelopes(narrative: TurnNarrative): FeedEnvelope[] {
  const out: FeedEnvelope[] = []
  let seq = 1

  for (const item of Object.values(narrative.steps)) {
    const step: StepEvent = {
      type: 'step',
      seq: seq++,
      name: item.tool,
      label: item.label,
      // `pending` is the in-flight state in the turn vocabulary; `started` is its name here.
      state: item.state === 'pending' ? 'started' : item.state,
      hidden: item.hidden,
    }
    out.push(step)
  }

  for (const diagnostic of narrative.diagnostics) {
    const error: ErrorEvent = {
      type: 'error',
      seq: seq++,
      // Fail to `server` rather than drop: an unrecognized source still carries a sentence
      // the user needs to see, and a swallowed diagnostic is a silent build failure.
      source: (ERROR_SOURCES.has(diagnostic.source) ? diagnostic.source : 'server') as ErrorSource,
      // EMPTY, and deliberately. The target `ErrorEvent` is the LEGACY feed's shape, which
      // still has these two fields because that transport still carries them; the turn stream
      // does not send them any more, so there is nothing to map. They are written explicitly
      // rather than omitted because the field list above is what makes a dropped field a
      // compile error, and that property is worth more than two blank strings cost.
      title: '',
      cleaned_stack: '',
      // THE HALF THE USER ACTUALLY READS.
      user_message: diagnostic.userMessage,
      user_action: diagnostic.userAction,
      // A diagnostic is a recovery in progress, never a terminal failure (the wire says so:
      // "the turn is not failing — a repair run follows").
      recovering: true,
    }
    out.push(error)
  }

  if (narrative.quota) {
    const quota: QuotaExceededEvent = {
      type: 'quota_exceeded',
      seq: seq++,
      limit: narrative.quota.limit,
      used: narrative.quota.used,
      resets_at: narrative.quota.resetsAt,
    }
    out.push(quota)
  }

  return out
}

/**
 * The phase this turn is in, in the status vocabulary the app pane reads. `null` means nothing
 * to say — the pane keeps whatever it already had. Ordering is deliberate: an unavailable
 * workspace is terminal no matter what else arrived, and a live preview outranks "still
 * provisioning" because the user can SEE it. Takes no chat-kind parameter — the distinction
 * between app work and a read-only answer is read off the frames themselves (see
 * `touchedTheApp` below), not declared by a caller.
 */
export function turnPhase(
  narrative: TurnNarrative,
  {
    running,
    terminal,
  }: {
    running: boolean
    terminal: 'completed' | 'failed' | 'stopped' | null
  }
): BuildSessionStatus | null {
  if (narrative.workspace === null) return null
  if (narrative.workspace.state === 'unavailable') return 'failed'
  // DID THIS TURN TOUCH THE APP? Generous on purpose — every one of these is a frame only a turn
  // doing app work emits, and under-reading it would leave the pane uncovered over a real build,
  // which is the louder wrong of the two. A question about a heading produces none of them.
  const touchedTheApp =
    Object.keys(narrative.steps).length > 0 ||
    narrative.diagnostics.length > 0 ||
    narrative.preview.url !== null ||
    narrative.preview.state !== null
  if (!touchedTheApp) {
    // A read turn has exactly one thing worth narrating: the 30-60s wait for its container,
    // while it is still happening. Everything after it belongs to the answer.
    return running && narrative.workspace.state === 'preparing' ? 'provisioning' : null
  }
  if (terminal === 'failed' || terminal === 'stopped') return 'failed'
  if (terminal === 'completed') return 'ended'
  if (!running) return null
  if (narrative.preview.state === 'ready') return 'ready'
  return narrative.workspace.state === 'preparing' ? 'provisioning' : 'building'
}

/** What the composer's SEND control does while the citizen is out of budget. */
export interface AtLimitSendState {
  /** Always true — the value exists so the call site reads as what it sets, not as a bare flag. */
  disabled: true
  /** The `title`, naming when sending starts working again. A control that will not act and does
   *  not say why is the single most frustrating state a UI can be in: it looks broken, and the
   *  reader has no way to tell whether waiting would help. */
  title: string
}

/**
 * The SEND control's state while today's budget is spent — `null` when it is not. Lives here
 * (not in the composer) because it reads FEED ENVELOPES, this module's vocabulary; the surface
 * asks and hands back a finished sentence. Describes the SEND control only, never the composer:
 * a citizen refused mid-thought usually has a draft worth keeping, so the textarea stays live to
 * select/copy/paste — take the composer down too and the draft is hostage until midnight.
 */
export function atLimitSendState(envelopes: FeedEnvelope[]): AtLimitSendState | null {
  // NEWEST WINS, by seq rather than by array order. A reconnect replays the stream and a resumed
  // subscriber receives frames out of order; picking the last ARRIVED envelope would hand back a
  // stale reset time from a replayed frame.
  const quota = bySeq(envelopes).filter(
    (env): env is QuotaExceededEvent => env.type === 'quota_exceeded',
  )
  const newest = quota.length > 0 ? quota[quota.length - 1] : null
  if (!newest) return null
  const when = formatResetTime(newest.resets_at)
  return {
    disabled: true,
    title: when ? `You can send again after ${when}` : 'You can send again after midnight',
  }
}

/**
 * `resets_at` as a time a person can read, or `null` when it is not a usable instant. FALLS
 * BACK rather than throwing: an unparseable wire value has already reached a renderer in the
 * existing tests — `new Date('x').toLocaleTimeString()` renders the literal "Invalid Date" into
 * the citizen's banner, worse than saying nothing. The caller's "after midnight" fallback is
 * true regardless, since the reset IS the next IST midnight.
 */
export function formatResetTime(isoUtc: string): string | null {
  const at = new Date(isoUtc)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Dedup by `seq` (last-wins) and order by `seq` — the replay property, kept. */
function bySeq(envelopes: FeedEnvelope[]): FeedEnvelope[] {
  const latest = new Map<number, FeedEnvelope>()
  for (const env of envelopes) latest.set(env.seq, env)
  return [...latest.values()].sort((a, b) => a.seq - b.seq)
}
