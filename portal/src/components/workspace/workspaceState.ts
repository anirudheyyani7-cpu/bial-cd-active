/**
 * ONE WORKSPACE STATE, COMPUTED ONCE, RENDERED TWICE (Plan F, U2).
 *
 * ═══ WHAT THIS MODULE ANSWERS, AND THE QUESTION IT REFUSES ═══
 *
 * It answers WHAT TO SAY: given what the platform reports about a project's one workspace, the
 * sentence a person reads and the at-most-one thing they may press. The app pane renders that
 * value; a Plan chat, which has no pane, renders the same value as a line above its composer. That
 * is what makes "no pane" structurally incapable of meaning "says nothing" — there is one author
 * for every workspace sentence in the product, and both surfaces are readers of it.
 *
 * IT DOES NOT ANSWER WHAT TO FRAME, and the output type carries no URL for exactly that reason.
 * The address comes from `utils/previewAddress.ts` and from nowhere else, with its precedence
 * intact — the live turn's preview outranks the session URL, because the live turn is the app
 * being built in front of the person while the session URL describes the previous build. A
 * `PreviewState` carries a `previewUrl` of its own and it is conveniently in hand right here;
 * framing it silently drops the top of that precedence. There is no field on `WorkspaceState` to
 * put it in, which is the enforcement.
 *
 * ═══ THE ACTION UNION HAS NO DESTRUCTIVE MEMBER, AND THAT IS THE POINT ═══
 *
 * Three members: start, retry, and go to the project that holds the workspace. There is no restore
 * verb, no rebuild verb and no teardown verb anywhere in the type, so an unknown state, a readiness
 * timeout, a `ready: false` and a missing field all land on "try again" — not because a guard
 * checks something first, but because "try again" and "start" are the only verbs that exist (R5,
 * L3, L7). Enforcement expressed as a type rather than as a rule somebody has to remember.
 *
 * BE PRECISE ABOUT WHAT THAT BUYS. It closes the CLIENT half of the recorded data-loss path and
 * only the client half. What `POST /relaunch` does when the word is pressed is the server's
 * behaviour, proved in `backend/tests/api/v1/build_sessions/`, and a client-side test asserting
 * "this component made no restore call" would pass in the very state that loses work — the
 * component was never the thing that could have destroyed it.
 *
 * ═══ THE COPY RULE (R-16, client call 2026-08-31) ═══
 *
 * The pane says what IS, never what is not. The stopped state's headline is "Your app is saved."
 * — full stop. Not "saved but not running", not "stopped". `not running` survives as an INTERNAL
 * state name, here and on the wire; it is never rendered. And R4a is taken literally: no sentence
 * names a duration the platform has not measured, so the starting state says what it is doing and
 * carries no number. If a measured cold-start baseline ever exists it arrives from one constant,
 * in one place, and not by somebody typing "about half a minute" into a string here.
 */
import type { PreviewLifeState, PreviewState } from '../../utils/buildSessionApi'
import { assertNever } from '../../utils/assertNever'

/**
 * THE BACKGROUND CADENCE and THE ANSWERS THAT END IT, moved here from `ConversationSurface.tsx`
 * so the two readers share one source rather than each keeping a private copy.
 *
 * The reason this is not left duplicated: the same file already records what happened the last
 * time a one-liner was copied instead of shared — two sites kept private `crypto.randomUUID()`
 * mints and both went on producing v4s long after the shared mint moved on. A cadence and a
 * terminal set that drift apart are worse than that, because the symptom is a poll that stops on
 * one surface and not on the other, with nothing red anywhere.
 */
export const PREVIEW_PROBE_MS = 45_000

/**
 * The answers that END the asking. All three are SETTLED FACTS about a workspace: nothing that
 * could change one of them happens without a reader hearing about it first. `unknown` is
 * deliberately absent — it is the one answer that decided nothing, so it must leave the timer
 * running rather than pin "we could not check" for the life of the tab.
 *
 * AND `restorable` BINDS THE SAME RULE. A settled `state` whose `restorable` is still `null` is
 * half an answer: the workspace is confirmed gone, but whether the work can be brought back was
 * not decided. Callers pair this set with a `restorable !== null` test; see `isTerminalReading`.
 */
export const SETTLED_GONE: ReadonlySet<PreviewLifeState> = new Set<PreviewLifeState>([
  'asleep',
  'slot_taken',
  'never_built',
])

/** Has the platform said everything it is going to say, so re-asking can only hear it again? */
export function isTerminalReading(preview: Pick<PreviewState, 'state' | 'restorable'>): boolean {
  return SETTLED_GONE.has(preview.state) && preview.restorable !== null
}

// ─── the cadence while a start is in flight (#203) ────────────────────────────────────────────

/**
 * THE ONE STATE WORTH ASKING ABOUT OFTEN, and the numbers that say how often and for how long.
 *
 * `starting` is the only reading whose successor arrives WITH NO GESTURE FROM ANYBODY — the
 * server holds the state, the container comes up, and the next read says `alive`. Every other
 * state changes because somebody did something, and the thing they did re-arms the poll on its
 * own. So a background cadence tuned for "has anything happened while nobody was looking" is the
 * wrong instrument for exactly one state, and #203 is the bill for using it there: an app serving
 * at t=2.7s, a pane still saying "Getting your app ready." at t=45.5s, and nothing animating in
 * between to suggest it was not simply hung.
 *
 * ═══ WHY 3 SECONDS ═══
 *
 * Chosen from the platform's own timings, because no start could be measured in the session that
 * wrote this (the Azure subscription was read-only) — and that is worth saying plainly rather
 * than dressing a guess as a measurement. Three anchors:
 *
 *  - `_ATTACHED_READY_BUDGET_SECONDS` is 15s server-side: a warm attach is expected to be serving
 *    inside it. An interval of 3s resolves such a start within a fifth of its own budget, so the
 *    lag the poll adds is small next to the event it is waiting for.
 *  - #203's one real measurement has the flip at 2.7s. At 3s that start is caught on the first or
 *    second accelerated read; at 45s it was caught 42.8s late.
 *  - The read is cheap by contract (C3 §8.3: one cache read, at most two rows and two object-store
 *    HEADs, no container call), so 20 of them a minute — only while somebody is watching a start —
 *    is a real cost and a small one.
 *
 * WHAT WOULD HAVE SETTLED IT BETTER: the distribution of `starting`→`alive` on real starts, warm
 * attach and cold create+pull separately, with the interval set near the tenth percentile and the
 * window near the ninety-fifth. Anyone holding that data should change these two numbers and say
 * so here.
 *
 * ═══ WHY IT STOPS ═══
 *
 * {@link STARTING_PROBE_LIMIT} accelerated reads is 120 seconds, which is
 * `_COLD_READY_BUDGET_SECONDS` — the budget the server itself gives the final `wait_ready` leg of
 * a cold start. Past it the platform is no longer confident this attempt is coming up, so neither
 * is this timer, and the asking falls back to the background cadence.
 *
 * FALLING BACK IS NOT A VERDICT. The reading is left exactly as it was — still `starting`, still
 * "Getting your app ready." — and the background poll goes on correcting it if the app lands two
 * minutes late. Reading an elapsed budget as a statement about the container is the precise
 * mistake in `docs/solutions/logic-errors/readiness-timeout-triggers-destructive-sandbox-restore-
 * 2026-08-02.md`, where a timeout was read as a death certificate and destroyed unsaved work.
 */
export const STARTING_PROBE_MS = 3_000

/** 120s of accelerated asking — the server's own cold-readiness budget. See {@link STARTING_PROBE_MS}. */
export const STARTING_PROBE_LIMIT = 40

/**
 * The poll's cadence, and how much of the accelerated window it has spent.
 *
 * A pair rather than a bare number because the two are decided together and drift apart the moment
 * they are not: a delay with no count polls a hung start for the life of the tab, and a count with
 * no delay is a budget nothing spends.
 */
export interface ProbeCadence {
  /** Milliseconds until the next read. */
  readonly delayMs: number
  /** Accelerated reads scheduled so far in the current window. Zero means no window is open. */
  readonly fastReads: number
}

/** No window open, asking at the background cadence. Where every poll starts and returns to. */
export const BACKGROUND_CADENCE: ProbeCadence = { delayMs: PREVIEW_PROBE_MS, fastReads: 0 }

/**
 * THE CADENCE DECISION, MADE FROM THE ANSWER — never from a dependency list.
 *
 * Both polls read the workspace inside an effect whose deps are `[projectId, epoch]`, and both
 * blank their reading on every re-run so a stale verdict cannot be left under a frame that has
 * moved. Adding the preview state to either dep list would therefore re-run the effect on the very
 * transition this exists to catch, flickering the pane through `could-not-read` and — on the chat
 * surface, since #192 — unframing an app that is running. So the reschedule happens HERE, inside
 * the read, on the `keepAsking`/`stopAsking` seam both effects already own.
 *
 * STRICTLY `starting`, and it reverts on anything else. A window that stayed open on `alive` would
 * put the whole product on a 3-second poll, which is the change nobody asked for.
 *
 * `unknown` NEITHER OPENS NOR CLOSES ONE. It decided nothing — the readers already refuse to let it
 * overwrite a verdict on screen — so it must not decide the cadence either. But it still SPENDS
 * from the window, because the bound is on reads made, not on answers liked: a server answering
 * `unknown` forever must not buy an unbounded fast poll.
 */
export function nextProbeCadence(answer: PreviewLifeState, held: ProbeCadence): ProbeCadence {
  if (answer !== 'starting' && answer !== 'unknown') return BACKGROUND_CADENCE
  if (answer === 'unknown' && held.fastReads === 0) return BACKGROUND_CADENCE
  if (held.fastReads >= STARTING_PROBE_LIMIT) {
    return { delayMs: PREVIEW_PROBE_MS, fastReads: held.fastReads }
  }
  return { delayMs: STARTING_PROBE_MS, fastReads: held.fastReads + 1 }
}

// ─── what came back from a start attempt ──────────────────────────────────────────────────────

/**
 * How the most recent press of the start control ended — and only the endings that are this map's
 * business. A start that SUCCEEDED produces none of these: the read takes over and reports
 * `alive` on its own. A reclaim refusal produces none either — it opens the hand-over dialog
 * (U5), which is a question, not a state of the workspace.
 *
 * R4b in one type: a start that does not end in a running app says WHICH WAY it ended. Three ways,
 * three sentences, one shared remedy.
 */
export type StartOutcome =
  /** The server answered, and answered `ready: false` — the container is up and has not served a
   *  page yet. NOT a death: the wire's own contract records that an ABSENT `ready` reads `true`,
   *  which is exactly why liveness can never hang off this boolean. */
  | { readonly kind: 'not-painted' }
  /** Nothing came back inside the budget. Says nothing about the container. */
  | { readonly kind: 'timed-out' }
  /** The server named a reason. Carried verbatim — this map does not rewrite server prose. */
  | { readonly kind: 'failed'; readonly reason: string }

// ─── what a person may press ──────────────────────────────────────────────────────────────────

/**
 * EXACTLY THREE VERBS EXIST. Adding a fourth is a deliberate act at this declaration, visible in
 * a diff, and every `switch` over it fails to compile until it is handled. That is the whole
 * mechanism behind "no unreadable signal can reach a destructive verb from the client".
 */
export type WorkspaceAction =
  | { readonly kind: 'start'; readonly label: string }
  | { readonly kind: 'retry'; readonly label: string }
  | { readonly kind: 'go-to-project'; readonly label: string; readonly projectId: string }

/** R-16: the person's word for the thing is their app. "Preview" is the developer's word. */
export const LAUNCH_LABEL = 'Launch Application'
const RETRY_LABEL = 'Try again'

const START: WorkspaceAction = { kind: 'start', label: LAUNCH_LABEL }
const RETRY: WorkspaceAction = { kind: 'retry', label: RETRY_LABEL }

// ─── the value both surfaces render ───────────────────────────────────────────────────────────

/**
 * INTERNAL NAMES, NEVER RENDERED. They exist so a test, a log line and a `switch` can talk about a
 * state without quoting its copy — and so the copy can be rewritten without a rename cascade.
 * `not-running` is the one to watch: it is a state name here and on the wire, and it is the exact
 * phrase R-16 forbids on screen.
 */
export type WorkspaceStateName =
  | 'never-built'
  | 'not-running'
  | 'starting'
  | 'running'
  | 'held-by-another-project'
  | 'held-unattributed'
  | 'could-not-read'
  | 'not-painted'
  | 'timed-out'
  | 'start-failed'

export interface WorkspaceState {
  /** The internal name. Never rendered — see the type's own note. */
  readonly name: WorkspaceStateName
  /** The sentence a person reads. Always present: a state with nothing to say is not a state. */
  readonly headline: string
  /** The line under it, or `null` when the headline is the whole of it. */
  readonly detail: string | null
  /** At most one. `null` is a real answer — "nothing built" and "starting" both offer none. */
  readonly action: WorkspaceAction | null
}

/**
 * Two states that say the same thing to a reader. Every member is a primitive or a small union of
 * them, so this is exact — and it is what lets a poll that keeps returning the same answer stop
 * waking the surfaces rendering it.
 */
export const sameWorkspaceState = (a: WorkspaceState, b: WorkspaceState): boolean =>
  a === b ||
  (a.name === b.name &&
    a.headline === b.headline &&
    a.detail === b.detail &&
    sameAction(a.action, b.action))

const sameAction = (a: WorkspaceAction | null, b: WorkspaceAction | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    a.label === b.label &&
    // Only `go-to-project` carries one, and comparing it on the arms that do not is `undefined`
    // against `undefined` — true, which is the right answer for them.
    (a as { projectId?: string }).projectId === (b as { projectId?: string }).projectId)

// ─── the inputs ───────────────────────────────────────────────────────────────────────────────

export interface WorkspaceInputs {
  /** The preview-state read. `null` before the first one lands. */
  readonly preview: PreviewState | null
  /**
   * The project row's own "is there anything to restore" — a cold-load answer that predates the
   * first read. Read with `??` against the read's fresher `restorable`, never `||`: `restorable`
   * is a TRI-STATE whose `null` means the object store could not be reached, which is not an
   * answer and must not retract a claim the project row already made.
   */
  readonly projectHasSavedBuild: boolean | null
  /** How the most recent start attempt ended, or `null` if none has been made or it succeeded. */
  readonly startOutcome: StartOutcome | null
  /**
   * A START IS IN FLIGHT RIGHT NOW, from this surface's own press.
   *
   * Without it the pane went on saying "Your app is saved." for up to a full poll cadence after
   * somebody pressed the button — true, but not an acknowledgement, and the only feedback was a
   * spinner inside the control. The server's own `starting` state is the honest answer and it
   * arrives on the next read; this is what covers the gap until it does, through the SAME arm, so
   * the sentence still has one author.
   */
  readonly startInFlight: boolean
}

// ─── the map ──────────────────────────────────────────────────────────────────────────────────

/**
 * A TOTAL FUNCTION over a closed input union. Every arm returns one of the three actions or none.
 *
 * THE PRECEDENCE, and each step is a claim about which source is more current:
 *
 *  1. NO READ YET → "could not read" with a retry. Not an empty pane: before the platform has
 *     said anything, the honest sentence is that we have not asked yet, and the retry is the
 *     only thing a person can usefully do with it.
 *  2. `alive` → running. A live container outranks any stale start outcome, because a start
 *     that reached `alive` succeeded whatever it reported on the way.
 *  3. `starting` → starting. Same reasoning, one step earlier.
 *  4. `slot_taken` → the hand-over states. This outranks a start outcome deliberately: R4b says
 *     another project holding the workspace offers the REMEDY, never a plain retry, and a retry
 *     against an occupied slot can only fail the same way again.
 *  5. a start outcome → its own sentence (R4b).
 *  6. `unknown` → could not read.
 *  7. `asleep` / `never_built` → resolved against whether anything can be brought back.
 *
 * A SERVER STATE THIS CLIENT DOES NOT RECOGNISE never reaches here: `asPreviewLifeState` narrows
 * it to `unknown` at the wire, which resolves to "could not read" with a retry — never to a
 * confident "gone". The `assertNever` at the bottom is what keeps that true when the union grows.
 */
export function resolveWorkspaceState(inputs: WorkspaceInputs): WorkspaceState {
  const { preview, projectHasSavedBuild, startOutcome, startInFlight } = inputs

  // A LIVE CONTAINER OUTRANKS AN IN-FLIGHT PRESS, and nothing else does. If the read already says
  // the app is serving, the start succeeded — saying "getting your app ready" over a running app
  // would be the pane contradicting the frame beside it. Everything below `alive` yields, because
  // a press is newer than any of them: a stale `asleep`, an unknown, or a previous attempt's
  // ending are all facts from before the button was pressed.
  if (startInFlight && preview?.state !== 'alive') return gettingReady()

  if (preview === null) return couldNotRead()

  switch (preview.state) {
    case 'alive':
      return {
        name: 'running',
        headline: 'Your app is running.',
        detail: null,
        action: null,
      }
    case 'starting':
      return gettingReady()
    case 'slot_taken':
      return heldElsewhere(preview)
    case 'unknown':
      return couldNotRead()
    case 'asleep':
    case 'never_built':
      return startOutcome ? fromStartOutcome(startOutcome) : atRest(preview, projectHasSavedBuild)
    default:
      return assertNever(preview.state)
  }
}

/**
 * SLOT_TAKEN IS TWO ARMS, AND NEITHER IS AN ERROR.
 *
 * With a name and an id: name the project and offer the way to it. Without them: say that another
 * project holds the workspace and NAME NONE. That withholding is a first-class wire state, not a
 * bug to paper over — the server declines to attribute a container it cannot map to a project this
 * person owns, because naming the wrong project in a sentence about somebody's work is worse than
 * naming none. The failure this arm is written against is a sentence with an empty pair of quotes
 * in it, which is what a template does when it trusts the name to be there.
 *
 * The id is required for the action and not merely nice to have: without it the remedy is a button
 * that navigates nowhere, which is worse than no button. Name and id go missing together — the
 * wire parser makes sure of it — so one `if` covers both.
 */
function heldElsewhere(preview: PreviewState): WorkspaceState {
  const { occupyingProjectName: name, occupyingProjectId: id } = preview
  if (name === null || id === null) {
    return {
      name: 'held-unattributed',
      headline: 'Another project is using your workspace.',
      detail: 'You have one workspace at a time, and we could not tell which project has it.',
      action: null,
    }
  }
  return {
    name: 'held-by-another-project',
    headline: `“${name}” is using your workspace.`,
    detail: 'You have one workspace at a time. Open that project to pick up where you left off.',
    action: { kind: 'go-to-project', label: `Open “${name}”`, projectId: id },
  }
}

/**
 * R4b — three endings, three sentences, one remedy.
 *
 * All three offer the plain retry, and that is the whole of what the client may offer: none of
 * them is evidence the container is gone, so none of them may reach a verb that assumes it is.
 */
function fromStartOutcome(outcome: StartOutcome): WorkspaceState {
  switch (outcome.kind) {
    case 'not-painted':
      return {
        name: 'not-painted',
        headline: 'Your app is up, but it has not served a page yet.',
        detail: null,
        action: RETRY,
      }
    case 'timed-out':
      return {
        name: 'timed-out',
        headline: 'Your app did not answer in time.',
        // Deliberately not "it failed": a budget elapsing is a fact about our waiting, not about
        // the container, and the app is very often up moments later.
        detail: 'It may still be coming up.',
        action: RETRY,
      }
    case 'failed':
      return {
        name: 'start-failed',
        headline: 'We could not start your app.',
        // The server's own words, carried verbatim. Rewriting them here would put a second author
        // on a sentence that already has one, and lose the only specific thing we know.
        detail: outcome.reason,
        action: RETRY,
      }
    default:
      return assertNever(outcome)
  }
}

/**
 * AT REST, resolved against whether there is anything to bring back.
 *
 * `restorable ?? projectHasSavedBuild`, and the `??` is doing real work: `restorable`'s `null` is
 * "no claim" — the object store was unreachable, or the poll declined to spend a round trip — so
 * it falls through to the project row's older-but-real answer rather than retracting it.
 *
 * ONLY A DEFINITE `false` SUPPRESSES THE START CONTROL, and that is not a stylistic choice. The
 * server holds neither a recovery copy nor a saved bundle in that case, so `POST /relaunch`
 * answers 404 — offering "Launch Application" there is a button whose only outcome is an error.
 * What is left is the same affordance a project with nothing built has: ask for the app. So both
 * resolve to the SAME arm, which also keeps the pane from reporting an absence at somebody who
 * cannot act on it.
 */
function atRest(preview: PreviewState, projectHasSavedBuild: boolean | null): WorkspaceState {
  const canRestore = preview.restorable ?? projectHasSavedBuild
  if (canRestore === true) {
    return {
      name: 'not-running',
      // R-16, VERBATIM AND CLIENT-APPROVED. Full stop after "saved". No negation follows it, and
      // the sentence beneath carries the rest without one.
      headline: 'Your app is saved.',
      detail: 'It stays running while you work, so you only do this once.',
      action: START,
    }
  }
  return {
    name: 'never-built',
    // An invitation, not a report of an absence. "Nothing has been built here" is true and
    // useless; this is the sentence that tells a person what to do next.
    headline: 'Describe what you want to build.',
    detail: 'Your app will appear here as it takes shape.',
    action: null,
  }
}

/**
 * THE ONE HONEST ANSWER TO A QUESTION NOBODY MANAGED TO ASK.
 *
 * Reached from an `unknown` read and from having no read at all. Says nothing about the
 * container, promises nothing about the work, and offers the only verb that is safe against a
 * signal we could not interpret.
 */
/**
 * R4a, TAKEN LITERALLY. This sentence says what is happening and names no number, because nobody
 * has measured one. The canvas's "about thirty seconds" and the register's "about half a minute"
 * are both deliberately dropped; a duration arrives from a measured constant or not at all.
 *
 * ONE FUNCTION FOR TWO ARRIVALS. The server's `starting` and this surface's own in-flight press are
 * the same state — a start is happening — and giving them one sentence is what keeps them from
 * drifting into two slightly different waits.
 */
function gettingReady(): WorkspaceState {
  return {
    name: 'starting',
    headline: 'Getting your app ready.',
    detail: null,
    action: null,
  }
}

function couldNotRead(): WorkspaceState {
  return {
    name: 'could-not-read',
    headline: 'We could not check on your app.',
    detail: 'Nothing has changed while we were asking.',
    action: RETRY,
  }
}
