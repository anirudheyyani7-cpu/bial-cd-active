/**
 * WHAT GETS FRAMED, decided once. The app pane is rendered by the address, not the route: the
 * shell mounts one iframe for the whole workspace and the element exists whenever this module
 * returns a URL, which only works if the decision is made from ABOVE the chat. PURE — signals in,
 * an address and a status out; no hooks, fetches or refs. `null` when no source qualifies, never a
 * fallback: a pane framing nothing is correct, one framing the wrong app is not.
 *
 * THE PRECEDENCE, AND TWO PREDICATES THAT ARE NOT THE SAME PREDICATE:
 *   1. the live turn's preview      — CHAT-scoped   (`narratingChatIsOpenChat`)
 *   2. a relaunched URL             — PROJECT-scoped
 *   3. the live session's URL       — PROJECT-scoped, and additionally needs a session to exist
 *   4. the project's live preview   — PROJECT-scoped, ranked last
 *
 * WHY THIS EXISTS — THE ASYMMETRY IS LOAD-BEARING, not a tidy-up target. The turn arm is gated by
 * the chat predicate ALONE, the three below it by the project predicate alone. Merging them into
 * one "is this ours" test breaks both directions at once: it stops a live turn framing in the case
 * that matters most (a chat whose project the page's session was never stamped with), and it lets
 * one project's build frame into another project's pane. `previewAddress.test.ts` and
 * `ConversationSurface-previewaddress.test.tsx` each carry a scenario.
 *
 * A THIRD SCOPE IS NAMED HERE AND KEPT OUT: APP-scoped facts (the compile state, whether the
 * workspace was lost) are about the project's ONE app and deliberately NOT narrowed to the open
 * chat, since their producer outlives the turn — blanking them on a chat switch leaves an error
 * screen uncovered. They stay ordinary pass-through props.
 */
import type { BuildSessionStatus } from './buildSessionTypes'

export interface PreviewAddressInputs {
  // ── chat-scoped ───────────────────────────────────────────────────────────────────────────
  /** The URL the live turn last named, whichever chat it was narrating. */
  turnPreviewUrl: string | null
  /**
   * The live turn's build status — top of the STATUS precedence, deliberately independent of
   * which arm won the URL: a provisioning build has a status and no URL yet, which is what
   * renders the loading state instead of an empty pane.
   *
   * Gated by the chat predicate IN HERE even though its only caller hands it in already gated —
   * an arm carries its predicate INTO the module rather than relying on the caller having
   * derived one above the JSX, because a gate that depends on where it was declared is one
   * reorder away from silently opening.
   */
  turnStatus: BuildSessionStatus | null
  /** THE CHAT PREDICATE. Is the turn that produced the signals above narrating the OPEN chat? */
  narratingChatIsOpenChat: boolean

  // ── project-scoped ────────────────────────────────────────────────────────────────────────
  /**
   * A restored app. It has no build lifecycle at all — no feed, no keep-alive, no lock —
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
   * The project's own live preview, from the preview-state read (`alive`: "a container is
   * serving this project; `previewUrl` is framable" — `buildSessionApi.ts`). RANKED LAST, and
   * the only arm that needs no chat: the three above it need a live turn, a relaunch, or a
   * session, so at a bare project address on a fresh load none of that exists.
   *
   * IT HAS TWO CALLERS. `components/workspace/ProjectWorkspace.tsx` is the project-scoped
   * publisher this arm was written for, and `components/chat/ConversationSurface.tsx` joined it:
   * a chat opened cold — a hard load, a bookmark, a browser restart — has no session either, so it
   * needs the same arm or it says the app is running over an empty frame. Both feed only the
   * `alive` case, the one state whose `previewUrl` the wire's own contract calls framable. Until
   * the first caller landed, this arm had no caller at all and the bare project screen published
   * nothing, so the pane host hit its "no pane and no address" early return and rendered nothing
   * on a fresh load.
   *
   * THE PRECEDENCE BELOW IS LOAD-BEARING FOR THE SECOND CALLER: this arm outranks
   * `transcriptHasBuildOutcome ? 'ended'`, so once the chat route feeds it, a transcript that
   * ended is no longer allowed to declare the preview gone while a container is demonstrably
   * serving the project.
   */
  projectPreviewUrl: string | null
  /** THE PROJECT PREDICATE. Do the project-scoped signals above belong to the OPEN project? */
  sessionBelongsToOpenProject: boolean

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
    sessionBelongsToOpenProject, transcriptHasBuildOutcome,
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

  return { url, status }
}
