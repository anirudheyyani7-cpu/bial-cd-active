/**
 * THE READ BEHIND THE WORKSPACE STATE.
 *
 * WHY THIS EXISTS
 * `workspaceState.ts` is pure; this is the half that talks to the server — one cheap read, on
 * a cadence, turned into the one value the pane and the Plan-chat line both render.
 *
 * It runs even with NO FRAME on screen — unlike the conversation surface's own preview probe,
 * which only asks while a frame is actually live, right for a pane watching a framed app get
 * reclaimed underneath it. That is exactly wrong here: a project whose app is saved but not
 * running has no address at all, and that no-frame state is precisely what this hook exists to
 * describe, and to carry the product's one start control for.
 *
 * `fetchPreviewState` is CHEAP BY CONTRACT: one cache read, at most two rows, at most two
 * object-store HEADs, no container call — safe on a timer. `fetchSaveState` is not: it runs two
 * `git` executions inside the container, so it is called only when the read says `alive` (asking
 * a stopped project about unsaved work would attach to a dead workspace, which the platform
 * forbids); a stopped project shows no save state and no commit. `fetchCompileState` and
 * `checkWorkspace` are not called from here at all — they belong to a surface with a live turn
 * behind it, and both cost a container exec.
 *
 * `starting`'s successor arrives with no user gesture, so it is polled faster, at
 * {@link STARTING_PROBE_MS} rather than {@link PREVIEW_PROBE_MS} — and `nextProbeCadence` owns
 * that window and its bound. A read that throws still spends from it (`spendProbeCadence`), and an
 * accelerated tick skips `fetchSaveState` even on `alive`, since a container seconds old is still
 * booting. The thirty-minute stay can still lapse unnoticed, since `RELAUNCH_PREVIEW_STAY_SECONDS`
 * is renewed only by a turn's own deadline writers — the next read returns `asleep`, one press to
 * recover, nothing lost.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchPreviewState, fetchSaveState, samePreviewState, sameSaveState } from '../../utils/buildSessionApi'
import type { PreviewState, SaveState } from '../../utils/buildSessionApi'
import {
  BACKGROUND_CADENCE,
  STARTING_PROBE_MS,
  isTerminalReading,
  nextProbeCadence,
  resolveWorkspaceState,
  spendProbeCadence,
  type ProbeCadence,
  type StartOutcome,
  type WorkspaceState,
} from './workspaceState'

export interface WorkspaceReading {
  /** WHAT TO SAY. The single value the pane and the Plan-chat line both render. */
  state: WorkspaceState
  /**
   * The raw read, for the one caller that needs more than a sentence out of it: the project
   * surface builds the pane's address from this same result rather than starting a second poll.
   * The pure map's refusal to carry a URL is about the MAP's type; it is not a bar on the caller
   * that already holds the read using it.
   */
  preview: PreviewState | null
  /** The save model — non-null only while the workspace is `alive`. See the cost note above. */
  save: SaveState | null
  /** Record how the most recent start attempt ended. `null` clears it (a start that worked). */
  reportStartOutcome: (outcome: StartOutcome | null) => void
  /** A press has begun, or finished. Drives the map's in-flight arm. */
  reportStartPending: (pending: boolean) => void
  /** Ask again NOW. A deliberate gesture: a start that just finished, or a retry press. */
  refresh: () => void
}

export interface WorkspaceReadOptions {
  /** `null` while a route is still resolving one — nothing is asked until it does. */
  projectId: string | null
  /** The project row's own restore answer, for a cold load before the first read lands. */
  projectHasSavedBuild: boolean | null
}

export function useWorkspaceState({
  projectId,
  projectHasSavedBuild,
}: WorkspaceReadOptions): WorkspaceReading {
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [save, setSave] = useState<SaveState | null>(null)
  const [startOutcome, setStartOutcome] = useState<StartOutcome | null>(null)
  // A press is in flight. See `WorkspaceInputs.startInFlight` for why the map needs to know: the
  // server's own `starting` arrives on the next read, and this covers the gap until it does.
  const [startInFlight, setStartInFlight] = useState(false)
  // NOT DERIVED FROM ANYTHING, and it cannot be. A retry press is a synchronous fact whose only
  // observable state change can be collapsed into one commit by React's batching, so an
  // invalidation spelled as "something changed" is one a fast enough server erases. A counter
  // cannot be batched away: the value the effect sees is always different from the one before.
  const [epoch, setEpoch] = useState(0)

  const refresh = useCallback(() => setEpoch((n) => n + 1), [])
  const reportStartOutcome = useCallback((outcome: StartOutcome | null) => {
    setStartOutcome(outcome)
  }, [])
  const reportStartPending = useCallback((pending: boolean) => {
    setStartInFlight(pending)
    // A press supersedes whatever the LAST attempt ended as. Leaving a stale "did not answer in
    // time" standing under a fresh start is the pane arguing with the button somebody is holding.
    if (pending) setStartOutcome(null)
  }, [])

  // Read inside the async body without re-arming the effect. A start outcome must not restart the
  // poll — it is a fact about a press, not about the workspace — but the save read below has to
  // see the CURRENT project, which the effect's own closure already gives it.
  const projectRef = useRef(projectId)
  projectRef.current = projectId

  useEffect(() => {
    if (!projectId) {
      setPreview(null)
      setSave(null)
      return undefined
    }
    let live = true
    // A GENERATION COUNTER RATHER THAN AN IN-FLIGHT BOOLEAN. Tabbing back fires `visibilitychange`
    // and `focus` on the same gesture with the interval possibly mid-flight underneath them, so up
    // to three reads are in the air at once and settle in whatever order the network decides. A
    // boolean would DROP the later read — and the later read holds the fresher answer, so on
    // exactly the gesture where somebody is asking to be brought up to date it would answer with
    // the reading they already had.
    let latest = 0
    let timer: ReturnType<typeof setInterval> | null = null
    // WHAT THE ANSWERS SO FAR HAVE DECIDED ABOUT THE CADENCE, and what the running timer was
    // actually armed with. Two variables because they answer different questions: `cadence` is
    // the decision, `armed` is the fact — and re-arming an interval that already runs at the
    // right delay would reset its phase on every tick, which is a poll that never fires.
    let cadence: ProbeCadence = BACKGROUND_CADENCE
    let armed: number | null = null
    const stopAsking = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
      armed = null
    }
    const keepAsking = () => {
      if (timer !== null && armed === cadence.delayMs) return
      if (timer !== null) clearInterval(timer)
      armed = cadence.delayMs
      // The tick carries HOW IT WAS SCHEDULED, decided here rather than read from `cadence` when
      // it fires: the answer that closes an accelerated window is the one that changes `cadence`,
      // so a tick reading it at fire time would call itself a background read on the strength of
      // a decision it had not made yet.
      const accelerated = armed === STARTING_PROBE_MS
      timer = setInterval(() => void read(accelerated), armed)
    }

    // `accelerated` is false for the mount read and for both visibility handlers. Those are a
    // fresh surface and a deliberate human act — neither is the 3-second timer, and neither
    // should be denied the container read a background tick makes.
    const read = async (accelerated = false) => {
      if (!live || document.visibilityState !== 'visible') return
      const generation = ++latest
      try {
        const next = await fetchPreviewState(projectId)
        // Superseded: a later read started, so its answer is newer whatever order the responses
        // arrived in. Bail before touching state OR the timer — an overtaken read calling
        // `stopAsking()` would end the poll on a verdict that has already been replaced.
        if (!live || generation !== latest) return
        // AN `unknown` NEVER OVERWRITES A DECIDED VERDICT. A blip must not pull a running app off
        // screen, and it must not wipe a settled answer somebody is already reading either. It is
        // recorded only when nothing has been decided yet — because "we could not check" is a real
        // thing to say when it is the only thing we know.
        // HOLDING THE OLD REFERENCE WHEN NOTHING CHANGED is not an optimisation detail here: this
        // poll runs every 45 seconds on every project screen, and the reading is identical on
        // almost all of them. A fresh object each tick republishes the workspace report, which
        // wakes the shell, and re-renders the rail's whole conversation list — for an answer
        // nobody's screen can tell apart from the one already up.
        setPreview((prev) => {
          if (next.state === 'unknown' && prev) return prev
          return samePreviewState(prev, next) ? prev : next
        })

        if (next.state === 'alive') {
          // THE ONLY CONTAINER CALL THIS HOOK MAKES, and it is gated on a live container for the
          // reason in the docblock. Its failure is silent on purpose: a save state we could not
          // read is `null`, which is the tri-state's "no claim", and every consumer already
          // treats that as "could not tell" rather than as "clean".
          //
          // AND ON A BACKGROUND TICK. An accelerated read is the 3-second timer that watches a
          // start land, so the container it would ask has been alive for seconds and is still
          // restoring and booting — two `git` executions are the last thing it needs, and the
          // answer is the one the next background tick gives for free. The acceleration must cost
          // cheap reads and nothing else (#203). SKIPPED, NOT RETURNED FROM: this read still owes
          // the timer below its cadence decision, and an early exit here would leave the 3-second
          // interval running over an app that is already up.
          if (!accelerated) {
            const state = await fetchSaveState(projectId).catch(() => null)
            if (!live || generation !== latest || projectRef.current !== projectId) return
            setSave((prev) => (sameSaveState(prev, state) ? prev : state))
          }
        } else {
          // Not alive, so nothing to compare and nothing that could still be true. Holding a save
          // state from a container that has since stopped would arm the unsaved-work guard against
          // work that is no longer reachable.
          setSave(null)
        }

        // THE RESCHEDULE, MADE FROM THE ANSWER (#203) — see `nextProbeCadence`. It sits here, with
        // the stopping rule, because both are the same question asked of the same reading: what
        // this answer means for when we ask next.
        cadence = nextProbeCadence(next.state, cadence)
        if (isTerminalReading(next)) stopAsking()
        else keepAsking()
      } catch {
        // A read that could not answer SAYS NOTHING. Painting "gone" on a network blip is the
        // over-claiming this whole shape exists to remove, and the timer is left running so the
        // next tick can correct it.
        //
        // BUT IT STILL SPENDS FROM THE ACCELERATED WINDOW. Until it did, the 120-second bound was
        // a ceiling on SUCCESSFUL reads only, so a workspace that reached `starting` and then began
        // erroring was asked every three seconds for the life of the tab — the exact hang the bound
        // exists to prevent, reachable by a 500. See `spendProbeCadence` for why it may spend
        // without deciding anything.
        //
        // GUARDED THE SAME WAY THE SUCCESS PATH IS, plus one of its own. A superseded read must not
        // move the cadence a newer one already set, and `timer === null` is a poll a settled answer
        // already stopped — re-arming it here would let a failing endpoint resurrect a poll that
        // had correctly given up. `keepAsking` and nothing else: a failure is never terminal.
        if (!live || generation !== latest || timer === null) return
        cadence = spendProbeCadence(cadence)
        keepAsking()
      }
    }

    // KEPT LIVE EVEN AFTER THE TIMER STOPS, deliberately. These fire on a deliberate human act —
    // tabbing back to the project — never on a clock, so they are bounded by the person rather
    // than by a cadence. They are also the only backstop for the one thing this effect's inputs
    // cannot see: another tab restoring, or taking, this project's workspace.
    const onVisible = () => void read()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    keepAsking()
    void read()
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      stopAsking()
    }
  }, [projectId, epoch])

  return {
    state: resolveWorkspaceState({ preview, projectHasSavedBuild, startOutcome, startInFlight }),
    preview,
    save,
    reportStartOutcome,
    reportStartPending,
    refresh,
  }
}
