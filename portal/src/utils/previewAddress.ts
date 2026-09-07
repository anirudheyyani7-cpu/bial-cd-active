/**
 * WHAT GETS FRAMED, decided once (Plan A, U2).
 *
 * The app pane is about to stop being rendered by the route and start being rendered by the
 * address: the shell mounts one iframe for the whole workspace, and the *element exists* whenever
 * this module returns a URL. That only works if the decision can be made from ABOVE the chat —
 * which is precisely what the builder page's render body could not do, because the precedence was
 * spelled inline at the framing sites and its two scoping predicates were free variables derived
 * further up the same function.
 *
 * ═══ THE PRECEDENCE, AND THE TWO PREDICATES THAT ARE NOT THE SAME PREDICATE ═══
 *
 *   1. the live turn's preview      — CHAT-scoped   (`narratingChatIsOpenChat`)
 *   2. a relaunched URL             — PROJECT-scoped
 *   3. the live session's URL       — PROJECT-scoped, and additionally needs a session to exist
 *   4. the project's live preview   — PROJECT-scoped, ranked last
 *
 * THE ASYMMETRY IS LOAD-BEARING AND IT IS NOT A TIDY-UP TARGET. The turn arm is gated by the chat
 * predicate ALONE; the three below it are gated by the project predicate alone. Merging the two
 * into one "is this ours" test breaks it in both directions at once: it stops a live turn framing
 * in the one case that matters most (the citizen watching their build in a chat whose project the
 * page's session was never stamped with), and it lets one project's build frame into another
 * project's pane. `previewAddress.test.ts` has a scenario for each half, and
 * `ConversationSurface-previewaddress.test.tsx` has the same asymmetry at the page level.
 *
 * ═══ THREE SCOPES, AND ONLY TWO OF THEM LIVE HERE ═══
 *
 * There are three scopes in play on this pane, not two:
 *
 *  - CHAT-scoped   — the live turn's preview and its reconnecting flag. About the open conversation.
 *  - PROJECT-scoped — the relaunched URL, the session's URL, whether a turn is running anywhere in
 *                     this project. About the project, not the chat.
 *  - APP-scoped    — the compile state, and whether the workspace was lost. Facts about the
 *                     project's ONE app, deliberately NOT narrowed to the open conversation,
 *                     because their producer outlives the turn and blanking them on a chat switch
 *                     is what leaves an error screen uncovered.
 *
 * The third scope is named here so it is documented somewhere, and then deliberately kept OUT of
 * this module: the app-scoped facts are not address sources, they answer *what to say about the
 * app* rather than *what to frame*, and pulling them in "for consistency" is how the compile signal
 * gets narrowed to a chat. They stay ordinary pass-through props with their reasons beside them.
 *
 * ═══ WHAT THIS MODULE WILL NOT DO ═══
 *
 * It is PURE — identities and raw signals in, an address, a status and its liveness out. No hooks,
 * no fetches, no refs (a ref's current value is passed as an argument, never read in here). It returns `null`
 * for the address when no source qualifies: it never invents a fallback and it never widens a
 * scope to produce one. A pane framing nothing is a correct answer; a pane framing the wrong app
 * is not.
 */
import type { BuildSessionStatus } from './buildSessionTypes'

export interface PreviewAddressInputs {
  // ── chat-scoped ───────────────────────────────────────────────────────────────────────────
  /** The URL the live turn last named, whichever chat it was narrating. */
  turnPreviewUrl: string | null
  /**
   * The live turn's build status — the top of the STATUS precedence, and deliberately independent
   * of which arm won the URL: a build that is provisioning has a status and no URL yet, and that
   * pair is what renders the loading state instead of an empty pane.
   *
   * Gated by the chat predicate in here even though its only caller today hands it in already
   * gated. The point of this module is that an arm carries its predicate INTO it rather than
   * relying on the caller having derived one above the JSX — a gate that depends on where it was
   * declared is one reorder away from silently opening, which is the note the builder page's own
   * comments already carry about this exact pair of predicates.
   */
  turnStatus: BuildSessionStatus | null
  /** THE CHAT PREDICATE. Is the turn that produced the signals above narrating the OPEN chat? */
  narratingChatIsOpenChat: boolean

  // ── project-scoped ────────────────────────────────────────────────────────────────────────
  /**
   * A restored app (#43). It has no build lifecycle at all — no feed, no keep-alive, no lock —
   * which is why it resolves the status to `ready` on its own rather than reading one.
   */
  relaunchedUrl: string | null
  /** The live session's framed URL, and its status. Both additionally require `sessionId`. */
  sessionUrl: string | null
  sessionStatus: BuildSessionStatus | null
  /**
   * The live session's id, or `null` when this page owns no session.
   *
   * A SEPARATE INPUT FROM THE PROJECT PREDICATE, because the two lower arms do not gate the same
   * way and a merge would lose the difference: a relaunch resolves on the project predicate alone
   * (there may be no session at all — that is the ordinary "come back later" case), while the
   * session's URL and status additionally need a session to exist.
   */
  sessionId: string | null
  /**
   * The project's own live preview, from the preview-state read, whose contract says exactly when
   * this is framable: `alive` — "a container is serving this project; `previewUrl` is framable"
   * (`buildSessionApi.ts`). RANKED LAST, and it is the only arm that does not require a chat:
   * the three above it all need a live turn, a relaunch performed in this session, or a session.
   * At a bare project address on a fresh load there is none of that, so without this arm the
   * project screen frames nothing.
   *
   * IT HAS TWO CALLERS. `components/workspace/ProjectWorkspace.tsx` is the project-scoped
   * publisher this arm was written for, and `components/chat/ConversationSurface.tsx` joined it
   * (#192): a chat opened cold — a hard load, a bookmark, a browser restart — has no session
   * either, so it needs the same arm or it says the app is running over an empty frame. Both feed
   * only the `alive` case, the one state whose `previewUrl` the wire's own contract calls framable.
   * Until the first caller landed, this arm had no caller at all and the bare project screen
   * published nothing, so the pane host hit its "no pane and no address" early return and rendered
   * nothing on a fresh load.
   *
   * THE PRECEDENCE BELOW IS LOAD-BEARING FOR THE SECOND CALLER, and it moved a fixture. This arm
   * outranks `transcriptHasBuildOutcome ? 'ended'`, so once the chat route feeds it, a transcript
   * that ended is no longer allowed to declare the preview gone while a container is demonstrably
   * serving the project. Three tests in `ConversationSurface-session.test.jsx` answered `alive` for
   * every project id as scenery and asserted "no longer running"; they now say what they mean.
   */
  projectPreviewUrl: string | null
  /** THE PROJECT PREDICATE. Do the project-scoped signals above belong to the OPEN project? */
  sessionBelongsToOpenProject: boolean
  /**
   * The legacy C3 session ended, and ended as a SUCCESS — so its container was pardoned and the
   * session's own URL is still being served.
   *
   * A SEPARATE INPUT RATHER THAN A READING OF `sessionStatus`, because `ended` alone does not say
   * how: a session torn down by a stop or a failure is `ended` too, and treating those as live
   * would keep framing a URL nobody is answering. The end REASON lives on the session hook, so it
   * travels in here as its own predicate rather than being re-derived — the same discipline the
   * two scoping predicates above follow.
   */
  sessionEndedCompleted: boolean

  // ── transcript-derived ────────────────────────────────────────────────────────────────────
  /**
   * The open chat's transcript records a build that finished. The BOTTOM of the status
   * precedence and nothing more: it says a build once ran here, so a reloaded tab shows the
   * terminal placeholder and its Relaunch rather than the idle "submit a prompt" empty state.
   * It never contributes a URL — a persisted outcome's URL names a container that is long gone.
   */
  transcriptHasBuildOutcome: boolean
}

export interface PreviewAddress {
  /** What to frame, or `null` for "nothing qualifies" — never a guess and never a fallback. */
  url: string | null
  /**
   * What the pane should say about it. `null` means nothing is framed and nothing ended — it is
   * the idle state, and it must never be read as a terminal.
   */
  status: BuildSessionStatus | null
  /**
   * IS A CONTAINER STILL SERVING WHAT `url` NAMES? The whole of what `completedLive` used to be,
   * renamed to the question it actually answers and moved here (`#96`, `#199`, `#200`).
   *
   * ITS ONE JOB is to outrank a terminal `status`. A turn or a session ending does not take the
   * app down — the backend pardons the container unconditionally — so `ended` plus a serving
   * container means "the build is over and your app is still there", and the pane keeps framing it
   * instead of collapsing to "The preview is no longer running". Without this, pressing Stop, or
   * simply sending a second message after a build, pulled a running app off the screen.
   *
   * IT MAKES NO CLAIM ABOUT THE BUILD. "Alive" and "worth framing" are two questions and they stay
   * two: this one is answered by what is serving, and what the pane is allowed to SAY about the
   * newest build is answered by the compile state, whose `unknown` asserts nothing in either
   * direction. Reading this as "the build succeeded" is the exact conflation that put an unearned
   * "Build complete" on a screen where no build ever ran.
   */
  serving: boolean
}

/**
 * Resolve what the app pane frames, and what it says about it.
 *
 * The two results are computed independently on purpose, and that is not an oversight to be
 * refactored away: a build that is provisioning has a status and no URL (which is the loading
 * state), and a session that ended still has a status after its URL has stopped qualifying (which
 * is the terminal placeholder). Tying the status to whichever arm won the URL collapses both.
 */
export function resolvePreviewAddress(inputs: PreviewAddressInputs): PreviewAddress {
  const {
    turnPreviewUrl, turnStatus, narratingChatIsOpenChat,
    relaunchedUrl, sessionUrl, sessionStatus, sessionId, projectPreviewUrl,
    sessionBelongsToOpenProject, sessionEndedCompleted,
    transcriptHasBuildOutcome,
  } = inputs

  // The chat predicate, and ONLY the chat predicate. See the asymmetry note above.
  const fromTurn = narratingChatIsOpenChat ? turnPreviewUrl : null
  // The project predicate, and only it. A relaunch is a restore, not a build: it needs no session.
  const fromRelaunch = sessionBelongsToOpenProject ? relaunchedUrl : null
  // …and this one needs a session to exist as well, which is the distinction a naive merge loses.
  const hasLiveSession = sessionId != null && sessionBelongsToOpenProject
  const fromSession = hasLiveSession ? sessionUrl : null
  const fromProject = sessionBelongsToOpenProject ? projectPreviewUrl : null

  const url = fromTurn ?? fromRelaunch ?? fromSession ?? fromProject ?? null

  // A live turn's own status outranks everything — it is the only source describing what is
  // happening RIGHT NOW. Below it, the two arms with no lifecycle of their own resolve to `ready`
  // because that is what they are: an app that is up. The session's status sits between them so a
  // session that ended still renders its terminal placeholder rather than being overwritten by a
  // stale "the container is alive" read.
  const status =
    (narratingChatIsOpenChat ? turnStatus : null) ??
    (fromRelaunch ? 'ready' : null) ??
    (hasLiveSession ? sessionStatus : null) ??
    (fromProject ? 'ready' : null) ??
    (transcriptHasBuildOutcome ? 'ended' : null)

  // ═══ LIVENESS, AND WHY IT IS THREE SOURCES RATHER THAN ONE ═══
  //
  // The preview-state read is the BEST authority — it asks the server what is actually serving
  // this project, independent of any turn's history — but it is not the only one, because it is a
  // poll and a poll has not always answered yet. The two disjuncts beside it cover the moments it
  // has not: the instant a turn ends over a live preview, and the instant a session does. Both are
  // facts this render already holds, and dropping them would make a citizen watch their app
  // disappear for one poll interval every time a build finished.
  //
  // A TURN THAT PUBLISHED A PREVIEW COUNTS AS SERVING UNLESS IT FAILED, and that clause carries
  // both `#96` and `#200`.
  //
  //   `#96` — `turnStatus` is `'ended'` for a turn that COMPLETED and for one the citizen STOPPED,
  //           because the backend pardons the container either way. It is `'failed'` only for a
  //           turn that genuinely failed or lost its workspace. So the pardon rides on the phase
  //           rather than on a terminal reason string this module never sees.
  //   `#200` — the moment a citizen SENDS a second message, the surface resets the turn narrative
  //           and `turnStatus` drops to `null` while `turnPreviewUrl` keeps the URL the last
  //           `preview_ready` named. Requiring `'ended'` here would make liveness blink off for
  //           exactly that render — and the status, falling through to the transcript's own
  //           `'ended'`, would collapse `frameContext` and REMOUNT the iframe. That is the reload
  //           on every message: the app re-requests its document and throws away the citizen's
  //           form entries, their scroll position and their selected tab.
  //
  // SO `null` IS TREATED AS "STILL SERVING", AND THAT IS NOT A GUESS. `fromTurn` is non-null only
  // because a turn told this tab, on this chat, that an app was answering at that URL, and the
  // container behind it is not torn down by anything a turn does. `failed` is the one phase that
  // says otherwise, and it is excluded. A page that RELOADS starts with no turn preview at all, so
  // none of this can resurrect a stale claim — the terminal placeholder still wins there, which is
  // the `framedStatus` lesson this module already keeps.
  //
  // NO URL, NOTHING SERVING. Liveness describes what is framed; with nothing framed it is not
  // "false because the app is down", it is simply not a question, and `false` is the answer that
  // makes every reader (`keepFramed`, the terminal placeholder) behave as it did before.
  //
  // AND THE PROBE NEEDS NO INPUT OF ITS OWN. `fromProject` is already exactly "the preview-state
  // read answered `alive` for THIS project" — the arm's own docblock quotes the wire contract
  // saying so — and it already carries the project predicate. A second `containerAlive: boolean`
  // beside it would be the same fact spelled twice, from the same read, with nothing forcing the
  // two spellings to agree: a caller could feed a URL on one and `false` on the other and the
  // resolver would believe both. One expression, one source.
  //
  // Note it is `fromProject`, NOT "fromProject won the URL". A live turn's preview outranks it for
  // what to FRAME while describing the same container, so a project that is demonstrably serving
  // says so whichever arm supplied the address.
  const serving =
    url !== null &&
    (fromProject !== null ||
      (fromTurn !== null && turnStatus !== 'failed') ||
      (fromSession !== null && sessionEndedCompleted))

  return { url, status, serving }
}
