/**
 * The publish read and the publish request, behind one lifetime — everything the chip
 * needs to say where an app stands and to act on it.
 *
 * RENAMED, NOT REWRITTEN. This was `useDeployment`, and 287 of its 290 lines are
 * unchanged: the generation token, the poll lifetime, the cross-mount nudge and the
 * treatment of `unsaved_changes` as a question rather than a failure are exactly the parts
 * that rot when copied, which is why they were not. What changed is three derived values
 * that went, because the server now computes the one state they were guessing at.
 *
 * THE APPROVAL LIFECYCLE COMES THROUGH HERE TOO (U12), off the same status response. The
 * status card used to read `/apps/:id/status` itself, once, on mount — so a citizen who
 * pressed Publish and watched their app route into the queue sat there being told it was
 * still a draft. Hanging the lifecycle off this read is also the only way a surface with
 * no app id can show anything at all, and the builder's mount is exactly that.
 *
 * TWO REFRESH TRIGGERS BESIDES THE POLL, and they are worth telling apart.
 *
 * The visibility/focus listeners are what make the poll safe to stop: a publish can be
 * started from another tab, so a settled state is re-read whenever somebody actually looks
 * at this one. That is the cross-tab story, and it still works exactly as it did.
 *
 * The `bial:deployment-changed` nudge is NOT that. It is a `window` CustomEvent, so it never
 * leaves the document that dispatched it — it exists to reconcile two mounts on ONE screen,
 * which is what the retired publish card and review status card were: two inches apart,
 * where nothing is ever re-entered and a withdrawal in one left the other saying "waiting
 * for review".
 *
 * THE NUDGE IS LOAD-BEARING AGAIN, and this paragraph replaces one that said the opposite.
 * It used to record that the chip's two mount sites were SIBLING ROUTES under one Outlet, so
 * at most one could be live and the nudge had nobody to notify — kept only against a future
 * that might bring a second surface back. That future arrived: two DIFFERENT consumers now
 * hold separate reads and mount together on the workspace screen, the chip in
 * `WorkspaceToolbar` and `AppStatusPanel` in `WorkspaceRail`. `AppStatusPanel`'s own docblock
 * quotes the very sentence this one used to end on and answers it — "That moment is now."
 * So the nudge is what keeps them agreeing, not three spare lines waiting for a use.
 *
 * Its test renders two hooks explicitly and pins that contract. Anyone reading this as dead
 * code and deleting it would be reintroducing the withdrawal-in-one-surface bug, on a screen
 * where both surfaces are visible at once.
 *
 * AND IT IS RAISED FROM OUTSIDE THIS HOOK TOO — see `announceDeploymentChanged` (#205). A
 * publish is no longer the only thing that changes what this read returns: the LAST SAVED row
 * is `savedHead`/`savedAt` off this same response, and the surface that writes them holds no
 * publish read of its own.
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
 * SOMETHING OUTSIDE THIS HOOK CHANGED WHAT THIS READ WOULD RETURN (#205).
 *
 * The project screen's Save writes a new bundle, and the LAST SAVED row is `savedHead` and
 * `savedAt` — two fields of THIS read and of no other. The surface that performs the save holds
 * no publish read at all: the row is drawn by `AppStatusPanel` and the state by the toolbar's
 * chip, each with its own. So the save raises the nudge those two already listen to and both
 * reconcile off one dispatch, which is exactly the case the nudge was kept alive for.
 *
 * The alternative — a second deployment fetch inside the workspace's own refresh epoch — would
 * duplicate a reader and still leave the chip naming the previous version.
 */
export function announceDeploymentChanged(projectId: string): void {
  dispatchDeploymentChanged(projectId, NO_MOUNT)
}

/**
 * THREE DERIVED VALUES ARE GONE FROM HERE, and their absence is the point of the unit
 * that removed them: `running` (`status === 'running'`), `waitingForReview`
 * (`approval.status === 'pending'`) and `routed` (the last routed POST, held so a surface
 * could re-render it). Each was the browser re-deciding something the server had already
 * decided, and each was a place where two surfaces could disagree. The one publish state
 * on `deployment.publishState` says all three, and says them the same way to everyone.
 *
 * NOTHING HERE MAY GROW A PREDICATE BACK. If a consumer needs to know "is it live", "is it
 * waiting", "did it drift" — that is `publishState`, and if `publishState` cannot say it,
 * the fix is in the server that authors it.
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
  /** Pull the owner's own pending submission back out of the queue (P6). */
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
      // A RE-READ THAT FAILS KEEPS THE ROW IT ALREADY HAS (#205). `loadError` is rendered
      // FIRST by both surfaces and replaces everything — the pill, every provenance row and
      // the action become one line — so a 500 on the read that follows a save would blank the
      // whole panel on a screen that has just said "Saved". A row naming the previous version
      // is worse than one naming the current one and better than no panel at all, and the
      // citizen still has the state, the dates and the action they had a moment ago.
      //
      // THE FIRST READ IS THE EXCEPTION, and it is the one the branch below was written for:
      // a mount that has never had an answer has nothing better to show than the failure, and
      // a blank section there really would be indistinguishable from a broken page.
      if (everRead.current) return
      // EVERY FAILED READ LANDS IN ONE PLACE, and the 503 arm that used to sit above this
      // — blank the surface, report nothing — is deliberately gone. Three reasons, and the
      // first two are new since it was written. This is now the ONLY publishing surface
      // the citizen has, so a chip that renders nothing is indistinguishable from a broken
      // page. The server no longer 503s on a storage blip either: it degrades that to the
      // explicit unknown state and answers 200, so a 503 would not be what catches it
      // anyway. And the arm predates the change that made this read work without a deploy
      // pipeline at all, which is the configuration it was written for.
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
      // TWO success shapes (U9). Routing is not an error and must not be thrown: the
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
  // routed a version while this one still showed the button enabled. R15b relies on the
  // disabled waiting state to stop a second submit, but that state is only as fresh as the
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
