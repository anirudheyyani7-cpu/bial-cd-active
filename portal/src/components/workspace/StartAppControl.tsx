/**
 * THE ONE CONTROL THAT STARTS THE APP (Plan F, U3).
 *
 * ═══ IT RENDERS THE MAP'S ACTION, AND THE MAP REACHES NOTHING DESTRUCTIVE UNASKED ═══
 *
 * Four action members exist — start, retry, go to the project that holds the workspace, and take
 * the workspace back from it — and this component renders whichever one it is handed. There is no
 * fifth, so no unreadable signal can reach a teardown or a restore FROM HERE. That is a fact about
 * the client's vocabulary and this file will not claim more: what `POST /relaunch` does when the
 * word is pressed is the server's, proved in
 * `backend/tests/api/v1/build_sessions/test_preview_state.py`.
 *
 * ═══ THE TAKE-BACK (`#196`, D1/D2) — WHY THE SEQUENCE IS A HOOK AND NOT A HANDLER IN HERE ═══
 *
 * `useTakeBack` is exported for `AppPane` to call, and the button below is only its trigger. Three
 * reasons, and each is a defect that shape avoids:
 *
 *  1. THIS COMPONENT UNMOUNTS ROUTINELY MID-FLIGHT. The moment a start reaches the map the state
 *     stops offering an action, and the button that fired the request is gone before the request
 *     comes back. A take-back has a wait of up to two minutes with a MODAL standing on it — a
 *     dialog owned by a component that can vanish mid-sequence is a dialog that vanishes
 *     mid-sequence. `#210`'s rule, stated for a live region, is the same rule: the thing that
 *     outlasts the wait must be mounted in a parent that outlasts the wait.
 *  2. TWO CONTROLS, ONE PIECE OF WORK. The held arm draws `Open “<holder>”` and this, as two
 *     sibling mounts of this component, and D2 requires BOTH to go inert while the take-back runs.
 *     Siblings cannot share a `useState`; their parent can.
 *  3. IT MUST NOT REPORT `onStartPending`. `resolveWorkspaceState` answers `gettingReady()` on an
 *     in-flight press, `gettingReady()` offers no action, and `AppPane` renders a control only
 *     where there is one — so a take-back that used the ordinary in-flight channel would unmount
 *     its own button and un-frame the pane it is trying to fill. The in-flight state lives on the
 *     held arm, which is to say: here, in local state, and nowhere near the map.
 *
 * ═══ KNOW WHAT IS ON THE OTHER END OF THIS BUTTON ═══
 *
 * `relaunchPreview` → `POST /v1/build-sessions/relaunch` → `relaunch_preview`, which has two arms.
 * The ATTACH arm is safe: it reuses the live container, and since the SL-20 fix it fails open on a
 * readiness timeout rather than marking the registry `ending`. The RESTORE arm is not: it tears the
 * live container down before pulling the last saved bundle. This plan added the guard that keeps an
 * unreadable attach OUT of the restore arm, because that is the arm this control enters and it was
 * the recorded data-loss path with the guard missing.
 *
 * A stale-registry read of `asleep` against a container that is in fact live is still reachable —
 * the registry hash has no TTL, so an API restart orphans live containers. This control's job there
 * is to issue one ordinary start and surface whatever the server answers, INCLUDING a refusal. It
 * does not retry on its own, escalate, or offer a recovery verb: the container's survival in that
 * case is the server's to guarantee, and a client that invented a remedy would be guessing.
 *
 * ═══ MARKED UNAVAILABLE, NEVER DISABLED ═══
 *
 * `aria-disabled`, not `disabled`. Disabling a control that currently has focus blurs it to
 * `document.body`, which drops a keyboard user out of the interface at the exact moment something
 * is happening. The name and the reason stay on it throughout.
 *
 * ═══ THE VISIBLE LABEL IS THE REASON NOW (`#210`) ═══
 *
 * It used to be that only the `aria-label` changed while a start was in flight: the words on the
 * button read "Launch Application" whether it had been pressed or not, and the only moving part
 * was a spinning glyph — which `index.css` suppresses outright for a citizen who asks for less
 * motion. Pressed and unpressed were then indistinguishable on screen. The visible label carries
 * the state instead, and the `aria-label` that used to carry it alone is GONE rather than left
 * beside it: an override that restates the visible text is a second name for one control, and
 * WCAG's label-in-name rule wants the accessible name to BE the visible words.
 *
 * NO LIVE REGION HERE, deliberately. The pane this button starts already owns one persistent
 * polite region that speaks for every one of its states (`LivePreview`), and a second region
 * describing the same start announces it twice.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, PlayCircle, RotateCcw, ArrowRight, Undo2 } from 'lucide-react'
import {
  BuildSessionAlreadyActiveError,
  asReclaimBlocked,
  handOverWorkspace,
  relaunchPreview,
} from '../../utils/buildSessionApi'
import type { HandoverStep, ReclaimBlocked } from '../../utils/buildSessionApi'
import { ApiError } from '../../utils/apiError'
import { assertNever } from '../../utils/assertNever'
import type { StartOutcome, WorkspaceAction } from './workspaceState'
import type { WorkspaceReport } from './workspaceChannel'

/** A build already running in THIS project — a different cause with a different remedy. */
const BUILD_ALREADY_RUNNING = 'A build is already running in this project.'

export interface StartAppControlProps {
  action: WorkspaceAction
  report: WorkspaceReport
  /**
   * A TAKE-BACK IS IN FLIGHT ON THIS PANE, so every control on it is inert (D2).
   *
   * It is a prop rather than local state because the two controls the held arm draws are SIBLING
   * mounts of this component, and "both go inert while one of them works" is a fact neither of them
   * can hold. `AppPane` owns it, along with the sequence.
   */
  inert?: boolean
  /**
   * THE TAKE-BACK'S TRIGGER, from the parent that owns the sequence and outlives it.
   *
   * A surface that does not own one renders no take-back — which is not a fallback but the same
   * rule `PlanChatWorkspaceLine` already states for the other three members: the verb appears where
   * the thing behind it lives. `AppPane` is the only such surface.
   */
  takeBack?: TakeBack | null
}

export default function StartAppControl({ action, report, inert = false, takeBack = null }: StartAppControlProps) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  // TWO GUARDS, AND THEY ARE NOT THE SAME GUARD. The ref is synchronous, so two presses in one
  // tick collapse to one request — state would not have committed between them. `mounted` is what
  // keeps every `await` below from writing into a component the citizen has already navigated away
  // from, which is L6's rule for a start sequence.
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const start = useCallback(async () => {
    const projectId = report.projectId
    if (!projectId || inFlight.current) return
    inFlight.current = true
    setPending(true)
    // THE PANE HEARS THE PRESS IMMEDIATELY, not on the next poll tick. The server's own `starting`
    // is the authority and it arrives later; this is what stops the sentence above this button
    // saying nothing happened for up to forty-five seconds.
    report.onStartPending(true)
    try {
      const res = await relaunchPreview({ projectId })
      // NO MOUNTED GUARD BEFORE THE REPORT, and the distinction is the bug it was written as.
      //
      // `mounted` protects THIS component's own state. The report's handlers write into the
      // SURFACE — the workspace read, the address, the outcome slot — all of which outlive this
      // button and all of which need the answer. And this control unmounts routinely mid-flight:
      // the moment the press reaches the map, the state becomes `starting`, which offers no
      // action, so the button that fired the request is gone before the request comes back.
      //
      // Guarding here meant a start that SUCCEEDED reported nothing: no URL for the pane to frame,
      // no outcome to clear the wait. The screen sat on "Getting your app ready." forever while a
      // perfectly good container served underneath it.
      // THE URL FIRST, and before the outcome. It is what the surface frames, and reporting it
      // second would leave one commit in which the state says "running" and the pane has no
      // address to show for it. Handed over even when `ready` is false: the container is up and
      // the document is what has not arrived, so the frame's own load-gated reveal is the right
      // thing to be waiting on rather than a sentence in front of it.
      if (res.previewUrl) report.onStarted(res.previewUrl)
      // `ready === false` is "started but not painted yet", NOT "dead" — and an ABSENT `ready`
      // reads `true` by the wire's recorded contract, which is exactly why liveness can never hang
      // off this boolean. Safe here only because both sides of the read are non-destructive.
      report.onStartOutcome(res.ready ? null : { kind: 'not-painted' })
    } catch (err) {
      // Same reasoning as the success path above: a refusal has to reach the surface whether or
      // not the button that provoked it is still on screen.
      // DISCRIMINATED ON THE CODE BEFORE ANYTHING ELSE. A bare 409 is not self-describing: it
      // fires for a same-project reattach and for a cross-project block, and the two have
      // different remedies.
      const blocked = asReclaimBlocked(err)
      if (blocked) {
        // Another project holds the one workspace. Routed to the ONE dialog rather than shown as
        // a retry — retrying against an occupied slot can only fail the same way again.
        report.onReclaimRefusal(blocked, start)
        return
      }
      if (err instanceof BuildSessionAlreadyActiveError) {
        // Your own other chat is building. A different cause with a different remedy — finish or
        // stop it — so it must not be merged into the reclaim dialog, which would offer a Save
        // button that cannot help.
        report.onStartOutcome({ kind: 'failed', reason: BUILD_ALREADY_RUNNING })
        return
      }
      report.onStartOutcome(outcomeFor(err))
    } finally {
      inFlight.current = false
      report.onStartPending(false)
      if (mounted.current) setPending(false)
    }
  }, [report])

  switch (action.kind) {
    case 'start':
      return (
        <Control
          label={action.label}
          pending={pending}
          inert={inert}
          pendingLabel="Starting your app"
          icon={<PlayCircle size={15} />}
          onPress={() => void start()}
        />
      )
    case 'retry':
      return (
        <Control
          label={action.label}
          pending={pending}
          inert={inert}
          pendingLabel="Trying again"
          icon={<RotateCcw size={15} />}
          onPress={() => {
            // A retry clears the last outcome and asks again, then starts. Clearing first matters:
            // otherwise a second failure of the same kind would leave the sentence unchanged and
            // the press would look like it did nothing.
            report.onStartOutcome(null)
            void start()
          }}
        />
      )
    case 'go-to-project':
      return (
        <Control
          label={action.label}
          pending={false}
          // UNCHANGED IN LABEL AND BEHAVIOUR, per the owner's decision on `#196` — the only thing
          // `#196` adds to it is that it goes inert while its neighbour works, which is not a
          // change to what it does.
          inert={inert}
          pendingLabel=""
          icon={<ArrowRight size={15} />}
          onPress={() => navigate(`/projects/${action.projectId}`)}
        />
      )
    case 'take-back':
      // No sequence in the parent, no verb. See `StartAppControlProps.takeBack`.
      return takeBack ? (
        <Control
          label={action.label}
          pending={takeBack.working}
          // ONE SENTENCE FOR THE WHOLE SEQUENCE, and it is true at every step of it — the ask, the
          // stop, the save, the release and the start are all "taking your workspace back". The
          // step-by-step narration belongs to the dialog standing in front of this button
          // (`STEP_SAYS`), which is the surface a citizen is actually looking at while it runs.
          pendingLabel="Taking your workspace back"
          icon={<Undo2 size={15} />}
          // THE ALTERNATIVE, DRAWN AS ONE. `Open “<holder>”` is the remedy the product has always
          // offered and stays the thing the pane leads with; two solid primary buttons side by
          // side would put them on equal footing and make the destructive one look like the
          // expected answer.
          secondary
          onPress={takeBack.press}
        />
      ) : null
    default:
      return assertNever(action)
  }
}

// ─── THE TAKE-BACK (`#196`, D1/D2) ────────────────────────────────────────────────────────────

/**
 * What a pane needs in order to draw the take-back and the question behind it.
 *
 * Produced by {@link useTakeBack}, held by `AppPane`, and handed down to the button. Nothing here
 * is a `WorkspaceState` field: the map answers what is TRUE about the workspace, and a press that
 * is half way through a sequence is true about this tab only.
 */
export interface TakeBack {
  /** Press it. A second press while one is running is ignored, not queued. */
  press: () => void
  /** A take-back is in flight. Every control on the pane is inert; this one says what it is doing. */
  working: boolean
  /** The refusal the hand-over dialog is asking about, or `null` when no dialog is up. */
  asking: ReclaimBlocked | null
  /** How far the hand-over has got, for the dialog's own narration. `null` before it starts. */
  step: HandoverStep | null
  /** `true` saves the holder first. RESOLVES on every ending — see the docblock. */
  resolve: (save: boolean) => Promise<void>
  /** Close the question. Nothing has been stopped, saved or released. */
  cancel: () => void
}

/**
 * TAKE THE ONE WORKSPACE BACK — the whole sequence, and every way it can end.
 *
 * ═══ THE PRESS ASKS FOR THE WORKSPACE; IT DOES NOT REACH FOR THE HOLDER ═══
 *
 * The first thing a press does is `relaunchPreview` for THIS project — the same call the start
 * control makes, unchanged. The server is what refuses, with `sandbox_reclaim_blocked`, and that
 * refusal is what opens the dialog. Three things follow from doing it that way rather than from
 * synthesising a refusal out of the `slot_taken` reading in hand:
 *
 *  - THE DIALOG GETS REAL DATA. Its three copy arms are chosen from `dirty`, and it withholds the
 *    Save button entirely on a confirmed-clean holder. A `PreviewState` carries no `dirty`, no
 *    `building` and no `agentWorking`, so a synthesised refusal could only ever say "may have
 *    unsaved changes" — the exact hedge R94 removed, in front of somebody whose work is safe.
 *  - THE READING CAN BE STALE. If the slot was freed since the last poll, the ask simply succeeds
 *    and the app comes up: one press, no dialog, nothing stopped.
 *  - THE SAME CALL CLOSES THE SEQUENCE. What runs after the hand-over is this same function, so
 *    another tab taking the slot mid-sequence lands on the same refusal handling and re-asks the
 *    question with the NEW holder in it (D2's fifth ending) instead of needing an arm of its own.
 *
 * ═══ THE HANDLERS RESOLVE. THEY DO NOT REJECT (D1) ═══
 *
 * `ReclaimWorkspaceDialog` owns `busy` and `error` itself, and its `run()` catches EVERY rejection
 * into its own "That did not work. Please try again." alert while staying mounted. A take-back
 * whose handlers rejected would therefore report every failure through that one sentence, and D2's
 * five endings — which are pane states, with different copy and different remedies — would be
 * unreachable. So every ending here resolves, and the caller dismisses the dialog on all of them.
 * The pane is the single reporting surface.
 *
 * ═══ AND IT NEVER TOUCHES `captureReclaim` ═══
 *
 * On `/chat/{id}` the surface already owns a reclaim slot, and it is single-use, first-refusal-wins,
 * and its `resolve` awaits `retry()` — `fireRelayTurn(rawText, …)` for a refused send. Routing the
 * take-back through it would mean confirming the hand-over SENDS the message the citizen is holding
 * in the composer as a build instruction, and a refused send already holding the slot would swallow
 * the take-back's refusal outright. The take-back owns its own dialog and its own closure, and the
 * two never meet.
 *
 * ═══ WHAT `mounted` GUARDS, AND WHAT IT DELIBERATELY DOES NOT ═══
 *
 * State writes only. The report's handlers are called regardless, exactly as the start path calls
 * them: they write into the SURFACE, which outlives this pane's controls and needs the answer. So a
 * citizen who clicks away during the two-minute stop wait produces no state update and no crash,
 * and the server sequence — which is running server-side anyway — still completes.
 */
export function useTakeBack(report: WorkspaceReport | null): TakeBack {
  const [working, setWorking] = useState(false)
  const [asking, setAsking] = useState<ReclaimBlocked | null>(null)
  const [step, setStep] = useState<HandoverStep | null>(null)
  // Synchronous, so two presses in one tick collapse to one sequence — state would not have
  // committed between them.
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // READ AT PRESS TIME, NEVER HELD ACROSS A RENDER. `press` and `resolve` are stable identities so
  // the pane can pass them down without re-rendering its controls on every poll tick, and a stable
  // identity that closed over `report` would go on calling last minute's handlers.
  const reportRef = useRef(report)
  reportRef.current = report
  const askingRef = useRef(asking)
  askingRef.current = asking

  const ifStillHere = (write: () => void) => {
    if (mounted.current) write()
  }

  /**
   * ONE ASK FOR THE WORKSPACE, and all three things the answer can be.
   *
   * `stoppedHolder` is what this sequence has ALREADY done to the other project before getting
   * here — `null` on the opening ask, the holder's name once it has been stopped — and it travels
   * into the outcome untouched, because D2's rule is that any ending which stopped the holder says
   * so.
   */
  const askForTheWorkspace = async (
    rep: WorkspaceReport,
    projectId: string,
    stoppedHolder: string | null,
  ): Promise<void> => {
    try {
      const res = await relaunchPreview({ projectId })
      // THE URL FIRST, AND BEFORE THE OUTCOME, for the reason the start path records: reporting it
      // second leaves one commit in which the state says running and the pane has no address.
      if (res.previewUrl) rep.onStarted(res.previewUrl)
      rep.onStartOutcome(res.ready ? null : { kind: 'not-painted' })
      ifStillHere(() => setAsking(null))
    } catch (err) {
      const blocked = asReclaimBlocked(err)
      if (blocked) {
        // THE QUESTION, WITH WHOEVER IS HOLDING IT NOW. On the opening ask this is the dialog
        // appearing; after a hand-over it is D2's fifth ending — another tab took the freed slot —
        // and it is a return to the CHOICE screen with new data, never the dialog's generic caught
        // error. The caller force-remounts on the holder's id, so the copy and the focus move
        // together.
        ifStillHere(() => setAsking(blocked))
        return
      }
      rep.onStartOutcome({
        kind: 'take-back-failed',
        reason: err instanceof BuildSessionAlreadyActiveError ? BUILD_ALREADY_RUNNING : reasonFor(err),
        stoppedHolder,
      })
      ifStillHere(() => setAsking(null))
    }
  }

  const press = useCallback(() => {
    const rep = reportRef.current
    const projectId = rep?.projectId
    if (!rep || !projectId || inFlight.current) return
    inFlight.current = true
    setWorking(true)
    void (async () => {
      try {
        await askForTheWorkspace(rep, projectId, null)
      } finally {
        inFlight.current = false
        // THE PANE RE-ARMS THE MOMENT THE DIALOG IS UP. The citizen is deciding, not waiting, and
        // a Cancel that left both controls inert would be a dead end.
        ifStillHere(() => setWorking(false))
      }
    })()
    // Every value it reads comes through a ref, so this identity is correct for the life of the
    // pane — which is what keeps the two controls from re-rendering on every poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resolve = useCallback(async (save: boolean): Promise<void> => {
    const rep = reportRef.current
    const holder = askingRef.current
    const projectId = rep?.projectId
    if (!rep || !holder || !projectId || inFlight.current) return
    inFlight.current = true
    setWorking(true)
    // HOW FAR THE HAND-OVER GOT, and it is the ONLY thing that tells D2's endings apart. The order
    // is `handOverWorkspace`'s and lives there: stop, wait for the stop to genuinely finish, save,
    // release. A rejection while the step is still `stopping` therefore means nothing was stopped
    // — the holder is untouched and its own ceiling sentence says so — while a rejection at
    // `saving` or `releasing` means the holder is down and the slot is still held, which is a pair
    // of facts the pane has to state.
    let reached: HandoverStep = 'stopping'
    try {
      try {
        await handOverWorkspace(holder.projectId, save, {}, (next) => {
          reached = next
          ifStillHere(() => setStep(next))
        })
      } catch (err) {
        rep.onStartOutcome({
          kind: 'take-back-failed',
          // VERBATIM, including `buildSessionApi`'s own two-minute ceiling sentence. That one is
          // authored there, is true only on that ending, and is not to be replaced here.
          reason: reasonFor(err),
          stoppedHolder: reached === 'stopping' ? null : holder.projectName,
        })
        ifStillHere(() => setAsking(null))
        rep.onRefresh()
        return
      }
      ifStillHere(() => setStep('starting'))
      await askForTheWorkspace(rep, projectId, holder.projectName)
      // THE READING IS STALE WHATEVER JUST HAPPENED. The slot was released, so `slot_taken` is no
      // longer the answer — on the ending where the relaunch failed the pane needs the fresh
      // reading to reach `start-failed` rather than sitting on a hand-over that is over.
      rep.onRefresh()
    } finally {
      inFlight.current = false
      ifStillHere(() => {
        setWorking(false)
        setStep(null)
      })
    }
    // As `press` above: every value is read through a ref at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancel = useCallback(() => {
    // NOTHING HAS BEEN STOPPED, SAVED OR RELEASED. Cancel is only reachable while the dialog is
    // idle — it disables all three buttons while a request is in flight — so there is nothing to
    // undo and nothing to say about the other project.
    setAsking(null)
    setStep(null)
  }, [])

  return { press, working, asking, step, resolve, cancel }
}

/**
 * DID THE SERVER ANSWER, AND WHAT DID IT SAY? — the one question both callers below ask.
 *
 * An `ApiError` carrying a message means the server answered and named something, including
 * `handOverWorkspace`'s two-minute ceiling sentence, which is authored there and reaches the pane
 * unedited. Anything else — an aborted fetch, a dropped socket, a body that would not parse — is
 * not prose anybody wrote for a citizen, so it is `null` and the caller says its own thing.
 *
 * One function rather than two, because the two callers used to make this judgement separately
 * with identical code, and "what counts as the server having answered" is exactly the kind of rule
 * that drifts when it is stated twice. What they still decide for themselves is what to SAY when
 * the answer is `null` — and those two sentences are deliberately different (R4b).
 */
function serverMessage(err: unknown): string | null {
  return err instanceof ApiError && err.message ? err.message : null
}

/** WHY A TAKE-BACK STOPPED, in the server's own words wherever it gave any. */
function reasonFor(err: unknown): string {
  return serverMessage(err) ?? 'Nothing came back, so we could not tell what happened.'
}

/**
 * Anything the server named, carried verbatim; anything it did not, called a timeout.
 *
 * The distinction is R4b's: a start that does not end in a running app says WHICH WAY it ended, and
 * "we waited and nothing came back" is a different sentence from "the server said why".
 */
function outcomeFor(err: unknown): StartOutcome {
  const reason = serverMessage(err)
  return reason === null ? { kind: 'timed-out' } : { kind: 'failed', reason }
}

interface ControlProps {
  label: string
  /** THIS control is the one working: it renames itself and spins. */
  pending: boolean
  /**
   * Something ELSE on this pane is working, so this control is unavailable — but it is NOT
   * working, so it neither renames itself nor spins. Two flags rather than one because a
   * neighbour's spinner on a button nobody pressed says the wrong thing about what is happening.
   */
  inert?: boolean
  pendingLabel: string
  icon: React.ReactNode
  onPress: () => void
  /** The alternative rather than the expected answer — see the take-back's arm. */
  secondary?: boolean
}

function Control({ label, pending, inert = false, pendingLabel, icon, onPress, secondary = false }: ControlProps) {
  const unavailable = pending || inert
  return (
    <button
      type="button"
      // `aria-disabled`, NEVER `disabled` — see the docblock. The click handler checks the same
      // flag, so the control is inert without being unfocusable.
      aria-disabled={unavailable}
      // A property, not a speech: it marks the control as working without announcing anything,
      // which is what keeps this off the pane's live region. It goes on the control that is
      // ACTUALLY working, never on the one merely waiting for it.
      aria-busy={pending}
      onClick={() => {
        if (!unavailable) onPress()
      }}
      className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        secondary
          ? 'border border-canvas-rule bg-white text-tertiary hover:bg-bial-bg'
          : 'bg-primary text-white shadow-sm shadow-primary/30 hover:bg-primary-600'
      } ${unavailable ? 'opacity-60' : ''}`}
    >
      {pending ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : icon}
      {/* THE WORDS ARE WHAT CHANGES. With no `aria-label` over the top, this is also the
          accessible name — so the button renames itself from "Launch Application" to "Starting
          your app…" as it goes, and a reader on the control hears the change. */}
      {pending ? `${pendingLabel}…` : label}
    </button>
  )
}
