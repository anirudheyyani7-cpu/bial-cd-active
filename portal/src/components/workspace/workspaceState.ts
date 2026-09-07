/**
 * WHY THIS EXISTS: ONE WORKSPACE STATE, COMPUTED ONCE, RENDERED TWICE.
 *
 * It answers WHAT TO SAY: the sentence a person reads and the at-most-one thing they may press.
 * The app pane renders it; a Plan chat, which has no pane, renders the same value above its
 * composer — one author per workspace sentence, so "no pane" cannot come to mean "says nothing".
 *
 * IT DOES NOT ANSWER WHAT TO FRAME: there is no URL field to put one in, and that absence is the
 * enforcement. The address comes only from `utils/previewAddress.ts`, whose precedence — a live
 * turn's preview outranks the session URL — a `PreviewState` in hand here would silently drop.
 *
 * THE ACTION UNION REACHES NOTHING DESTRUCTIVE UNASKED. Four members: start, retry, go to the
 * project holding the workspace, and take it back. No restore, rebuild or teardown verb exists in
 * the type, so an unknown state, a timeout, a `ready: false` and a missing field all land on "try
 * again" — not because a guard checks something first, but because those arms have no other verb.
 *
 * THE FOURTH MEMBER ACTS ON SOMEBODY ELSE'S APP and still reaches nothing on its own: pressing it
 * asks this project's own start, and the server's refusal opens `ReclaimWorkspaceDialog`, which
 * saves the holder's work first and refuses to release anything on a failed save. Every verb the
 * client may reach is in this union, each `switch` failing to compile until a new member is
 * handled — but that closes the CLIENT half only. `POST /relaunch` is the server's, so a client
 * test asserting "this component made no restore call" passes in the very state that loses work.
 *
 * THE COPY RULE: the pane says what IS, never what is not — "Your app is saved.", full stop, not
 * "saved but not running". `not running` survives only as an internal state name, never rendered,
 * and no sentence names a duration the platform has not measured.
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

// ─── the cadence while a start is in flight ───────────────────────────────────────────────────

/**
 * THE ONE STATE WORTH ASKING ABOUT OFTEN, and the numbers that say how often and for how long.
 *
 * `starting` is the only reading whose successor arrives WITH NO GESTURE FROM ANYBODY — the
 * server holds the state, the container comes up, and the next read says `alive`. Every other
 * state changes because somebody did something, and the thing they did re-arms the poll on its
 * own. So a background cadence tuned for "has anything happened while nobody was looking" is the
 * wrong instrument for exactly one state, and using it there produced exactly the failure these
 * numbers exist to prevent: an app serving at t=2.7s, a pane still saying "Getting your app
 * ready." at t=45.5s, and nothing animating in between to suggest it was not simply hung.
 *
 * WHY 3 SECONDS. Chosen from the platform's own timings, because no start could be measured in
 * the session that wrote this (the Azure subscription was read-only) — and that is worth saying
 * plainly rather than dressing a guess as a measurement. Three anchors:
 *
 *  - `_ATTACHED_READY_BUDGET_SECONDS` is 15s server-side: a warm attach is expected to be serving
 *    inside it. An interval of 3s resolves such a start within a fifth of its own budget, so the
 *    lag the poll adds is small next to the event it is waiting for.
 *  - The one start measured directly had the flip at 2.7s. At 3s that start is caught on the
 *    first or second accelerated read; at 45s it was caught 42.8s late.
 *  - The read is cheap by contract — one cache read, at most two rows and two object-store HEADs,
 *    no container call — so 20 of them a minute — only while somebody is watching a start — is a
 *    real cost and a small one.
 *
 * WHAT WOULD HAVE SETTLED IT BETTER: the distribution of `starting`→`alive` on real starts, warm
 * attach and cold create+pull separately, with the interval set near the tenth percentile and the
 * window near the ninety-fifth. Anyone holding that data should change these two numbers and say
 * so here.
 *
 * WHY IT STOPS. {@link STARTING_PROBE_LIMIT} accelerated reads is 120 seconds, which is
 * `_COLD_READY_BUDGET_SECONDS` — the budget the server itself gives the final `wait_ready` leg of
 * a cold start. Past it the platform is no longer confident this attempt is coming up, so neither
 * is this timer, and the asking falls back to the background cadence.
 *
 * FALLING BACK IS NOT A VERDICT. The reading is left exactly as it was — still `starting`, still
 * "Getting your app ready." — and the background poll goes on correcting it if the app lands two
 * minutes late. Reading an elapsed budget as a statement about the container is the precise
 * mistake that once read a timeout as a death certificate and destroyed unsaved work.
 *
 * AND IT STOPS ON A CLOCK, NOT ON A TALLY OF ANSWERS WE LIKED. The bound is only a ceiling if
 * EVERY read spends from it — including the ones that came back with nothing.
 * `fetchPreviewState` throws on any non-2xx and on a dropped connection, and for as long as
 * only `nextProbeCadence` could advance the count, a workspace that reached `starting` and then hit
 * a 500, an expired session or a dead network was asked every three seconds FOR THE LIFE OF THE
 * TAB — twenty requests a minute, on both surfaces, with the 40-read bound that exists to prevent
 * exactly that never advancing a single step. {@link spendProbeCadence} is the other half, and both
 * polls call it from their `catch`.
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
 * surface — unframing an app that is running. So the reschedule happens HERE, inside the read, on
 * the `keepAsking`/`stopAsking` seam both effects already own.
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
  return spendOpenWindow(held)
}

/**
 * A READ THAT NEVER PRODUCED AN ANSWER — a 500, a dropped connection, an expired session — and what
 * it costs the accelerated window.
 *
 * IT SPENDS, AND IT DECIDES NOTHING. THAT ASYMMETRY IS THE WHOLE RULE.
 *
 * SPENDS, because {@link STARTING_PROBE_LIMIT} is meant as a ceiling on how long anybody may be
 * polled at three seconds, and a budget only successful reads draw from is no ceiling at all: an
 * endpoint erroring from the first tick pinned both polls at 3s forever, which is the bug this
 * exists to close.
 *
 * DECIDES NOTHING, because a failed read is not evidence about the workspace. It cannot tell you
 * whether the container is still coming up, and ending the window on it — or worse, letting it
 * reclassify the reading — would be reading a failure to ask as an answer. That is the same
 * mistake that once read an elapsed readiness budget as a death certificate and destroyed unsaved
 * work. So three things it deliberately does NOT do: it does not open a window (a poll that has
 * never seen `starting` must not be accelerated by a broken server — `fastReads === 0` stays at
 * background), it does not close one early (the remaining fast reads are still owed to a start
 * that may yet land the moment the endpoint recovers), and it does not touch the reading, which
 * stays whatever the last real answer made it.
 *
 * The consequence, stated plainly: a start that goes dark is polled fast for the SAME 120 seconds a
 * start that keeps answering `starting` gets, and then both fall back to 45s with the pane still
 * saying a start is happening — because it still is, as far as anyone here knows.
 */
export function spendProbeCadence(held: ProbeCadence): ProbeCadence {
  if (held.fastReads === 0) return BACKGROUND_CADENCE
  return spendOpenWindow(held)
}

/**
 * One read off an OPEN window: fast until the bound, the background delay past it, and the count
 * never rewinds — so a window cannot be re-opened by spending from it. Whether a window is open at
 * all is the caller's question; this only draws from one.
 */
function spendOpenWindow(held: ProbeCadence): ProbeCadence {
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
 * which is a question, not a state of the workspace.
 *
 * A start that does not end in a running app says WHICH WAY it ended. Three ways,
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
  /**
   * A TAKE-BACK THAT DID NOT FINISH — and the one ending that has to say what it did
   * to somebody ELSE's app on the way.
   *
   * It is a member of this union rather than a field beside it because it is the same kind of
   * fact: how the most recent press ended. It is a member of its OWN rather than a flag on
   * `failed` because it lands on a different arm — a take-back that got as far as stopping the
   * holder leaves the slot held, so the reading is still `slot_taken` and `heldElsewhere` is what
   * renders it, where a plain `failed` is deliberately outranked (see the precedence).
   */
  | {
      readonly kind: 'take-back-failed'
      /** Whichever step refused, in the server's own words. Carried verbatim, same as `failed`. */
      readonly reason: string
      /**
       * THE HOLDER WE ALREADY STOPPED, or `null` when the stop itself is what failed.
       *
       * This field exists for exactly one purpose: three of the five endings leave the other
       * project down — a failed save, a failed release, and a relaunch that could not take the
       * freed slot — and a pane that did not say so would leave somebody wondering why their
       * other app went quiet.
       * `null` is the ending where nothing moved, and only there may a sentence say so.
       */
      readonly stoppedHolder: string | null
    }

// ─── what a person may press ──────────────────────────────────────────────────────────────────

/**
 * EXACTLY FOUR VERBS EXIST. Adding a fifth is a deliberate act at this declaration, visible in a
 * diff, and every `switch` over it fails to compile until it is handled. That is the whole
 * mechanism behind "no unreadable signal can reach a destructive verb from the client".
 */
export type WorkspaceAction =
  | { readonly kind: 'start'; readonly label: string }
  | { readonly kind: 'retry'; readonly label: string }
  | { readonly kind: 'go-to-project'; readonly label: string; readonly projectId: string }
  /**
   * TAKE THE ONE WORKSPACE BACK — and it deliberately carries NO id.
   *
   * The obvious payload would be the holder's `occupyingProjectId`, mirroring the member above.
   * It is absent because the take-back does not act on the reading that produced this action: it
   * asks THIS project's own start for the workspace, and the holder it then names comes off the
   * server's `sandbox_reclaim_blocked` refusal — which carries the id, the name, and the `dirty`
   * tri-state the hand-over dialog's three copy arms are chosen from, none of which a
   * `PreviewState` has. That also makes the take-back correct in the one case a held id could not
   * be: another tab taking the slot mid-sequence, where the refusal names the NEW holder and the
   * reading names the old one.
   */
  | { readonly kind: 'take-back'; readonly label: string }

/** The person's word for the thing is their app. "Preview" is the developer's word. */
export const LAUNCH_LABEL = 'Launch Application'
const RETRY_LABEL = 'Try again'

const START: WorkspaceAction = { kind: 'start', label: LAUNCH_LABEL }
const RETRY: WorkspaceAction = { kind: 'retry', label: RETRY_LABEL }

// ─── the value both surfaces render ───────────────────────────────────────────────────────────

/**
 * INTERNAL NAMES, NEVER RENDERED. They exist so a test, a log line and a `switch` can talk about a
 * state without quoting its copy — and so the copy can be rewritten without a rename cascade.
 * `not-running` is the one to watch: it is a state name here and on the wire, and it is the exact
 * phrase the copy rule forbids on screen.
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
  /**
   * THE ONE A SURFACE LEADS WITH. `null` is a real answer — "nothing built" and "starting" both
   * offer none. On the held arm this stays exactly what it was before the take-back existed, per
   * the owner: `Open “<holder>”`, same label, same behaviour.
   */
  readonly action: WorkspaceAction | null
  /**
   * A SECOND THING TO PRESS, AND ONLY ONE ARM HAS EVER FILLED IT.
   *
   * OPTIONAL IN THE TYPE, MANDATORY IN THE MAP — and the asymmetry is deliberate rather than a
   * softness. A dozen suites hand-build a `WorkspaceState` to stand a component up, and requiring
   * every one of them to restate two nulls they have no opinion about buys nothing: the totality
   * that matters is the MAP's, and `workspaceState.test.ts` pins its whole key set, so an arm that
   * forgets either field fails a test rather than passing a compile. The same note applies to
   * `note` below.
   *
   * A SLOT RATHER THAN A LIST, and the choice is worth recording because a list was the obvious
   * shape. Two things decided it. The pane's two controls are not peers — one is the remedy the
   * product has always offered and the other is a new alternative to it, so a surface that wants
   * exactly the first (`PlanChatWorkspaceLine`, which renders the go-to and nothing else) reads a
   * named field instead of searching an array and re-narrowing what it finds. And every arm of
   * this map answers "at most one, plus at most one alternative", which an unbounded list would
   * stop saying — the next reader would have to look at all ten arms to learn that no arm has
   * ever offered three.
   *
   * `null` on every arm but `held-by-another-project`.
   */
  readonly secondAction?: WorkspaceAction | null
  /**
   * ONE EXTRA LINE, AND IT IS ONLY EVER ABOUT ANOTHER PROJECT.
   *
   * A take-back that got as far as stopping the holder and then failed has TWO things to report:
   * what went wrong with this app, which is the headline and the detail, and what it already did
   * to somebody else's, which is this. It is a field rather than a second sentence appended to
   * `detail` because they have different subjects and different lifetimes — the detail is
   * whichever server prose the failing step produced, and this is the map's own sentence about a
   * fact the citizen would otherwise have to discover by opening the other project.
   *
   * `null` everywhere else, which is every state that did nothing to anybody.
   */
  readonly note?: string | null
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
    // `?? null` because the two new fields are optional in the TYPE (see `WorkspaceState`), so an
    // omitted one and an explicit `null` are the same claim and must compare equal — otherwise a
    // hand-built value and the map's own would look like two different states to the cell.
    (a.note ?? null) === (b.note ?? null) &&
    sameAction(a.action, b.action) &&
    sameAction(a.secondAction ?? null, b.secondAction ?? null))

const sameAction = (a: WorkspaceAction | null, b: WorkspaceAction | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    a.label === b.label &&
    // Only `go-to-project` carries one, and comparing it on the arms that do not is `undefined`
    // against `undefined` — true, which is the right answer for them. `take-back` deliberately
    // carries no id of its own (see the union), so it is covered by that same comparison, and its
    // holder is inside the label anyway: a different holder is a different sentence.
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
 *  4. `slot_taken` → the hand-over states. This outranks a start outcome deliberately: another
 *     project holding the workspace offers the REMEDY, never a plain retry, and a retry against an
 *     occupied slot can only fail the same way again. ONE ENDING IS CARRIED ACROSS IT RATHER THAN
 *     OUTRANKED, and it is not an exception to that rule but the same rule read properly:
 *     `take-back-failed` describes a press made FROM this arm, against this holder, so it is not a
 *     stale fact about some earlier attempt — it is what just happened here. It changes no action;
 *     it adds what the citizen has to be told.
 *  5. a start outcome → its own sentence.
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
        secondAction: null,
        note: null,
      }
    case 'starting':
      return gettingReady()
    case 'slot_taken':
      return heldElsewhere(preview, startOutcome)
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
 * With a name and an id: name the project and offer the two ways out of it. Without them: say that
 * another project holds the workspace and NAME NONE. That withholding is a first-class wire state,
 * not a bug to paper over — the server declines to attribute a container it cannot map to a project
 * this person owns, because naming the wrong project in a sentence about somebody's work is worse
 * than naming none. The failure this arm is written against is a sentence with an empty pair of
 * quotes in it, which is what a template does when it trusts the name to be there.
 *
 * THE UNATTRIBUTED ARM GAINS NOTHING FROM THE TAKE-BACK, AND HERE IS WHY.
 *
 * Structurally, not by oversight. Both of this arm's controls NAME the project they act on, and the
 * take-back's whole safety is that the citizen knows whose work they are about to stop: a button
 * reading "Stop the other app and open this one" asks somebody to agree to an irreversible thing
 * about a project the platform has just admitted it cannot identify. That is the same judgement the
 * arm already makes about the go-to — naming none beats naming wrong — applied to the one control
 * where being wrong costs work rather than a wasted click. The name and the id go missing together,
 * so the arm that cannot label a take-back is exactly the arm that cannot navigate either, and one
 * `if` still covers both.
 *
 * AND THE TAKE-BACK CARRIES NO ID FROM HERE.
 *
 * `occupyingProjectId` is in hand and is deliberately NOT put on the second action — see the union.
 * The take-back asks this project's own start for the workspace and takes the holder off the
 * server's refusal, which is fresher than this reading and carries the `dirty` tri-state the
 * hand-over dialog needs and a `PreviewState` does not have.
 */
function heldElsewhere(preview: PreviewState, startOutcome: StartOutcome | null): WorkspaceState {
  const { occupyingProjectName: name, occupyingProjectId: id } = preview
  // WHAT A TAKE-BACK JUST DID, when it did not finish — endings 1, 3 and 4. All three land
  // back here — the slot is still held — and they are told apart by one fact: whether the holder
  // is down. Any other start outcome is still outranked, exactly as before.
  const failure = startOutcome?.kind === 'take-back-failed' ? startOutcome : null
  if (name === null || id === null) {
    return {
      name: 'held-unattributed',
      headline: 'Another project is using your workspace.',
      detail: 'You have one workspace at a time, and we could not tell which project has it.',
      action: null,
      secondAction: null,
      note: null,
    }
  }
  return {
    name: 'held-by-another-project',
    headline: `“${name}” is using your workspace.`,
    // THE SERVER'S OWN WORDS WHEN A TAKE-BACK JUST FAILED, and the standing sentence otherwise.
    // Ending 1's prose is `buildSessionApi.ts`'s ceiling sentence — "still saving its work.
    // Nothing has changed…" — which is authored there, is true only there, and is carried
    // verbatim rather than restated. That is also why nothing here writes a "nothing has changed"
    // of its own: on the save-failed and release-failed endings it would be a lie.
    detail: failure
      ? failure.reason
      : 'You have one workspace at a time. Open that project to pick up where you left off.',
    // UNCHANGED, PER THE OWNER. Same label, same behaviour, still the thing the pane leads with.
    action: { kind: 'go-to-project', label: `Open “${name}”`, projectId: id },
    secondAction: { kind: 'take-back', label: `Stop “${name}” and open this app instead` },
    // THE HOLDER IS DOWN AND THE SLOT IS STILL HELD, which is a pair of facts nobody would guess
    // from the headline alone — it says the other project is USING the workspace, and it is,
    // without anything running in it. Said in one sentence rather than left for the citizen to
    // discover by opening the other project and finding it stopped.
    note: failure?.stoppedHolder
      ? `“${failure.stoppedHolder}” was stopped, and it still holds your workspace.`
      : null,
  }
}

/**
 * Three endings, three sentences, one remedy.
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
        secondAction: null,
        note: null,
      }
    case 'timed-out':
      return {
        name: 'timed-out',
        headline: 'Your app did not answer in time.',
        // Deliberately not "it failed": a budget elapsing is a fact about our waiting, not about
        // the container, and the app is very often up moments later.
        detail: 'It may still be coming up.',
        action: RETRY,
        secondAction: null,
        note: null,
      }
    case 'failed':
      return {
        name: 'start-failed',
        headline: 'We could not start your app.',
        // The server's own words, carried verbatim. Rewriting them here would put a second author
        // on a sentence that already has one, and lose the only specific thing we know.
        detail: outcome.reason,
        action: RETRY,
        secondAction: null,
        note: null,
      }
    case 'take-back-failed':
      // A FAILED TAKE-BACK'S SECOND ENDING, AND THE EXPECTATION IT SUPERSEDES. "Returns to the
      // held-by-another state" is unreachable here: the release succeeded, so the holder is gone
      // and the slot is free — the only thing that failed is bringing this app up, which is
      // exactly what the existing failed-to-start sentence says. The one thing it does NOT say is
      // what became of the other project, and that is what the note is for.
      return {
        name: 'start-failed',
        headline: 'We could not start your app.',
        detail: outcome.reason,
        action: RETRY,
        secondAction: null,
        // Reached with a holder only from the arm that stopped one. A take-back whose very first
        // ask failed never got that far, and says nothing it did not do.
        note: outcome.stoppedHolder ? `“${outcome.stoppedHolder}” was stopped.` : null,
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
      // VERBATIM AND CLIENT-APPROVED. Full stop after "saved". No negation follows it, and
      // the sentence beneath carries the rest without one.
      headline: 'Your app is saved.',
      detail: 'It stays running while you work, so you only do this once.',
      action: START,
      secondAction: null,
      note: null,
    }
  }
  return {
    name: 'never-built',
    // An invitation, not a report of an absence. "Nothing has been built here" is true and
    // useless; this is the sentence that tells a person what to do next.
    headline: 'Describe what you want to build.',
    detail: 'Your app will appear here as it takes shape.',
    action: null,
    secondAction: null,
    note: null,
  }
}

/**
 * THE NO-INVENTED-DURATIONS RULE, TAKEN LITERALLY: this says what is happening and names no number,
 * because nobody has measured one. The canvas's "about thirty seconds" and the register's "about
 * half a minute" are both dropped; a duration arrives from a measured constant or not at all.
 *
 * ONE FUNCTION FOR TWO ARRIVALS. The server's `starting` and this surface's own in-flight press are
 * the same state — a start is happening — and one sentence keeps them from drifting into two waits.
 */
function gettingReady(): WorkspaceState {
  return {
    name: 'starting',
    headline: 'Getting your app ready.',
    detail: null,
    action: null,
    secondAction: null,
    note: null,
  }
}

/**
 * THE ONE HONEST ANSWER TO A QUESTION NOBODY MANAGED TO ASK.
 *
 * Reached from an `unknown` read and from having no read at all. Says nothing about the
 * container, promises nothing about the work, and offers the only verb that is safe against a
 * signal we could not interpret.
 */
function couldNotRead(): WorkspaceState {
  return {
    name: 'could-not-read',
    headline: 'We could not check on your app.',
    detail: 'Nothing has changed while we were asking.',
    action: RETRY,
    secondAction: null,
    note: null,
  }
}
