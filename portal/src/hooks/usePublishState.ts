/**
 * The publish read and the publish request, behind one lifetime — everything the chip needs
 * to say where an app stands and to act on it. Renamed from `useDeployment`; unchanged except
 * three derived values retired because the server now computes the one state they guessed at.
 *
 * The approval lifecycle rides the same status response, because a surface with no app id
 * (the builder, pre-submit) can show nothing else.
 *
 * WHY THIS EXISTS
 * Two refresh triggers besides the poll. The visibility/focus listeners are the cross-tab
 * story — a publish started elsewhere is picked up when this tab is looked at. The
 * `bial:deployment-changed` CustomEvent is the cross-mount story on one document: the chip
 * (`WorkspaceToolbar`) and `AppStatusPanel` (`WorkspaceRail`) mount together on the workspace
 * screen holding separate reads, and without the nudge a withdrawal in one leaves the other
 * saying "waiting for review" — the bug this closes. Its test renders two hooks explicitly
 * and pins the contract; deleting the nudge as apparently-dead code would reintroduce that
 * bug on a screen where both surfaces are visible at once.
 *
 * The nudge is also raised from outside this hook, by `announceDeploymentChanged`: a publish
 * is no longer the only thing that changes what this read returns — the last-saved row is
 * `savedHead`/`savedAt` off this same response, and the surface that writes them holds no
 * publish read of its own, so it raises the same nudge the chip and the status panel already
 * listen to.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  UNSAVED_CHANGES,
  getDeployment,
  startDeploy,
  type ApprovalState,
  type DataClassificationAnswers,
  type DeployOutcome,
  type DeploymentView,
} from '../utils/deployApi'
import { withdrawSubmission } from '../utils/approvalApi'
import { ApiError } from '../utils/apiError'

/** How often to ask where the deploy has got to. Five seconds: the pipeline's phases last
 *  tens of seconds to minutes, so anything tighter is load without extra information. */
const POLL_MS = 5000

/** The same-tab nudge every mount watching a project listens for. A CustomEvent on
 *  `window` rather than a store: there is exactly one fact to share ("re-read this
 *  project"), and the re-read already exists. */
const DEPLOYMENT_CHANGED = 'bial:deployment-changed'

interface DeploymentChanged {
  projectId: string
  /** The mount that acted. It has already refreshed synchronously as part of its own
   *  await chain, so it skips its own nudge rather than fetching the same row twice. */
  origin: number
}

let mountCounter = 0

/** The origin carried by a nudge raised from OUTSIDE any mount of this hook. Mount ids come
 *  from `++mountCounter`, so they begin at 1 and this can never be one of them — which is the
 *  whole property: a nudge nobody here owns has no mount to skip, so every mount on the
 *  project re-reads. */
const NO_MOUNT = 0

function dispatchDeploymentChanged(projectId: string, origin: number): void {
  window.dispatchEvent(
    new CustomEvent<DeploymentChanged>(DEPLOYMENT_CHANGED, { detail: { projectId, origin } }),
  )
}

/**
 * SOMETHING OUTSIDE THIS HOOK CHANGED WHAT THIS READ WOULD RETURN.
 *
 * The project screen's Save writes a new bundle, and the LAST SAVED row (`savedHead`, `savedAt`)
 * is two fields of THIS read and of no other. The saving surface holds no publish read at all:
 * the row is `AppStatusPanel`'s, the state the toolbar chip's, each with its own. So the save
 * raises the nudge those two already listen to and both reconcile off one dispatch, the case the
 * nudge was kept alive for. A second deployment fetch inside the workspace's own refresh epoch
 * would instead duplicate a reader and still leave the chip naming the previous version.
 */
export function announceDeploymentChanged(projectId: string): void {
  dispatchDeploymentChanged(projectId, NO_MOUNT)
}

/**
 * NOTHING HERE MAY GROW A PREDICATE BACK. `running`, `waitingForReview`, `routed` — derived
 * booleans the browser used to compute from raw fields — are gone: each was the browser
 * re-deciding something the server had already decided, and each was a place two surfaces
 * could disagree. `deployment.publishState` alone says all three, the same way to everyone;
 * if it can't say what a consumer needs, the fix belongs in the server that authors it.
 */
export interface UsePublishState {
  deployment: DeploymentView | null
  /** The app's approval lifecycle, off the same status response — null only when the
   *  project has no app yet. It is here for the VERSION ROWS the chip renders (which
   *  commit was submitted, which was approved, and when), never to decide a state. */
  approval: ApprovalState | null
  loadError: string | null
  /** Read it again. The publish surface offers this as its one action when the read
   *  itself failed — a chip that rendered nothing there would be indistinguishable from
   *  a broken page. */
  refresh: () => Promise<void>
  /** The server's `unsaved_changes` message, or null. Non-null means the "Save and publish"
   *  choice is outstanding. */
  unsaved: string | null
  saving: boolean
  /** Hand to the modal's `onConfirm`. Throws so the modal renders the refusal itself.
   *
   *  RESOLVES WITH THE OUTCOME, because the two successes are two different answers and
   *  only the caller can say them: `202 started` and `200 routed_for_review` both resolve,
   *  and a surface that could not tell them apart would have to guess which of the
   *  server's two sentences to speak. `null` means the request became the
   *  `unsaved_changes` QUESTION rather than an outcome — the one refusal that is not a
   *  failure and is therefore not thrown. */
  onConfirm: (answers: DataClassificationAnswers) => Promise<DeployOutcome | null>
  /** The second answer to that question. Same two outcomes; `null` when it failed, in
   *  which case the failure is already in `unsaved`. */
  saveAndPublish: () => Promise<DeployOutcome | null>
  dismissUnsaved: () => void
  /** Pull the owner's own pending submission back out of the queue. */
  withdraw: () => Promise<void>
  withdrawing: boolean
  withdrawError: string | null
}

export function usePublishState(projectId: string): UsePublishState {
  const [deployment, setDeployment] = useState<DeploymentView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  // Held here, not in the modal, so the "Save and publish" retry resends exactly what was
  // already declared instead of reopening the questionnaire.
  const pendingAnswers = useRef<DataClassificationAnswers | null>(null)

  // One generation token per mount+project. Every async write checks it, so a response for a
  // project the user has already navigated away from can never paint over the current one —
  // React Router reuses component instances across a projectId change.
  const generation = useRef(0)
  // Whether this mount has ever read THIS project's row. A ref rather than derived from
  // `deployment`, because reading that state here would put it in `refresh`'s dependencies and
  // re-run the mount effect — re-subscribing the listeners and re-reading — on every response.
  const everRead = useRef(false)
  // Stable for the life of the mount — identifies whose nudge is whose.
  const mountId = useRef(++mountCounter)

  const refresh = useCallback(async (): Promise<void> => {
    const mine = generation.current
    try {
      const next = await getDeployment(projectId)
      if (generation.current !== mine) return
      setDeployment(next)
      everRead.current = true
      setLoadError(null)
    } catch (err) {
      if (generation.current !== mine) return
      // A re-read that fails keeps the row it already has. `loadError` is rendered first by
      // both surfaces and replaces everything — the pill, every provenance row and the action
      // become one line — so a failed read that follows a save would blank the whole panel on
      // a screen that has just said "Saved". A row naming the previous version is worse than
      // one naming the current one and better than no panel at all, and the citizen still has
      // the state, the dates and the action they had a moment ago.
      //
      // The first read is the exception: a mount that has never had an answer has nothing
      // better to show than the failure, and a blank section there really would be
      // indistinguishable from a broken page.
      if (everRead.current) return
      // Every failed read lands in one place — blanking the surface and reporting nothing is
      // not an option here. This is the only publishing surface the citizen has, so a chip
      // that renders nothing is indistinguishable from a broken page. The server no longer
      // 503s on a storage blip either: it degrades that to the explicit unknown state and
      // answers 200, so special-casing 503 would not catch it, and this read no longer
      // requires a deploy pipeline to exist at all.
      setLoadError(err instanceof ApiError ? err.message : 'Could not read the publish status.')
    }
  }, [projectId])

  // Read once when the project resolves, then again whenever the tab is looked at.
  //
  // The focus listener is what makes the poll below safe to stop. A publish can be started
  // from the other surface or another tab, so this cannot ONLY refetch after its own button
  // press — but the answer to that is to check when someone is actually looking, not to hold
  // a timer open forever. An idle finished deploy costs nothing here.
  useEffect(() => {
    generation.current += 1
    everRead.current = false
    setDeployment(null)
    setUnsaved(null)
    setWithdrawError(null)
    pendingAnswers.current = null
    void refresh()

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    // The same-tab counterpart: another mount on this project just changed something, so
    // re-read rather than wait for a tab switch that will never come.
    const mine = mountId.current
    const onChanged = (event: Event): void => {
      const detail = (event as CustomEvent<DeploymentChanged>).detail
      if (detail.projectId !== projectId || detail.origin === mine) return
      void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener(DEPLOYMENT_CHANGED, onChanged)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener(DEPLOYMENT_CHANGED, onChanged)
    }
  }, [refresh, projectId])

  const announce = useCallback((): void => {
    dispatchDeploymentChanged(projectId, mountId.current)
  }, [projectId])

  const approval = deployment?.approval ?? null

  // Poll ONLY while something is in flight. A deploy is the only state that changes on its
  // own, so a timer outliving it is pure traffic — a finished deploy left this hitting the
  // API every five seconds for as long as the page stayed open, forever.
  //
  // THE GATE READS THE FIELD, not `status === 'running'` as it used to. Same answer in the
  // ordinary case and a better one at the edges: an app an administrator disabled or a
  // submission that routed while an OLD deployment row still sat `running` used to poll
  // for as long as the page stayed open, because the row alone never settles. The server's
  // own ordering rules those out before it ever says `starting_up`.
  const inFlight = deployment?.publishState === 'starting_up'
  useEffect(() => {
    if (!inFlight) return undefined
    const mine = generation.current
    const timer = window.setInterval(() => {
      if (generation.current === mine) void refresh()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [inFlight, refresh])

  const send = useCallback(
    async (answers: DataClassificationAnswers, saveFirst: boolean): Promise<DeployOutcome> => {
      // TWO success shapes. Routing is not an error and must not be thrown: the
      // modal would render it in red beside the button, and the citizen would read "your
      // app was sent for review" as a failure of the thing they just asked for.
      const outcome = await startDeploy(projectId, { answers, saveFirst })
      pendingAnswers.current = null
      setUnsaved(null)
      await refresh()
      announce()
      return outcome
    },
    [projectId, refresh, announce],
  )

  // Errors propagate to the modal, which renders them beside the button while the answers are
  // still on screen. `unsaved_changes` is the exception: not a reason to fail, but a question
  // with a second answer, so it is surfaced as a choice instead.
  //
  // EVERY OTHER ERROR REFRESHES BEFORE IT RETHROWS. A 409 here is usually the server
  // telling this surface something it did not know yet — most often `waiting_for_review`,
  // where another tab (or the other publish control, mounted on a different page) already
  // routed a version while this one still showed the button enabled. The disabled waiting
  // state stops a second submit, but that state is only as fresh as the
  // last poll. Rethrowing alone left the modal open on state the server had already
  // contradicted, until the next tick happened to correct it.
  const onConfirm = useCallback(
    async (answers: DataClassificationAnswers): Promise<DeployOutcome | null> => {
      pendingAnswers.current = answers
      try {
        return await send(answers, false)
      } catch (err) {
        if (err instanceof ApiError && err.code === UNSAVED_CHANGES) {
          setUnsaved(err.message)
          return null
        }
        // Fire-and-forget on purpose: the caller is about to see the error either way, and
        // making them wait on a second round trip to read it would be worse.
        void refresh()
        throw err
      }
    },
    [send, refresh],
  )

  const saveAndPublish = useCallback(async (): Promise<DeployOutcome | null> => {
    const answers = pendingAnswers.current
    if (!answers) return null
    setSaving(true)
    try {
      return await send(answers, true)
    } catch (err) {
      setUnsaved(
        err instanceof ApiError ? err.message : 'Could not save and publish. Please try again.',
      )
      return null
    } finally {
      setSaving(false)
    }
  }, [send])

  const dismissUnsaved = useCallback(() => {
    setUnsaved(null)
    pendingAnswers.current = null
  }, [])

  // The app id comes off the status response, not a prop: the toolbar surface never had
  // one, and taking it from the same read that says the app is pending is what keeps the
  // withdrawal aimed at the app the citizen is actually looking at.
  const appId = deployment?.appId ?? null
  const withdraw = useCallback(async (): Promise<void> => {
    if (appId === null || withdrawing) return
    setWithdrawing(true)
    setWithdrawError(null)
    try {
      await withdrawSubmission(appId)
      await refresh()
      announce()
    } catch (err) {
      // A 409 means an administrator got there first; the server's copy says so.
      setWithdrawError(
        err instanceof ApiError ? err.message : 'Could not withdraw this submission. Try again.',
      )
    } finally {
      setWithdrawing(false)
    }
  }, [appId, withdrawing, refresh, announce])

  return {
    deployment,
    approval,
    loadError,
    refresh,
    unsaved,
    saving,
    onConfirm,
    saveAndPublish,
    dismissUnsaved,
    withdraw,
    withdrawing,
    withdrawError,
  }
}
