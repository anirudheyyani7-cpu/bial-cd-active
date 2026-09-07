/**
 * THE BROWSER'S "THIS CHAT IS GETTING LONG" WARNING.
 *
 * ══ IT WARNS. IT NEVER REFUSES. ══
 *
 * The hard boundary is the SERVER's — `enforce_context_limit` refuses the turn at the route
 * with a sentence of its own, before anything is persisted. That is deliberate and it is the
 * lesson of what this file replaces: the two-page portal enforced the whole guardrail in the
 * browser, so when `ChatPage.tsx` was deleted the boundary went with it, an administrator was
 * left setting a number nothing read, and a citizen's first news of the limit was a failed turn
 * with no reason. A guard only the client holds is not a guard.
 *
 * So this file's job is smaller and honest: warn EARLY ENOUGH that the citizen can finish their
 * thought and start a new chat, rather than being stopped mid-sentence.
 *
 * ══ IT NO LONGER ESTIMATES ANYTHING, AND THAT IS THE POINT ══
 *
 * This file used to carry a declared twin of the server's estimator — four characters to the
 * token, a flat nominal for an image, another for a document — so that the meter a citizen
 * watched and the wall the server enforced were "two readings of one scale". They were two
 * readings of one GUESS, and the guess was wrong by 47x on a document: a 61-page upload really
 * cost 153,342 tokens and both sides recorded 1,600 (#194). Every one of those constants is
 * deleted, here and on the server, and nothing estimates in their place.
 *
 * What decides the warning now is the token count the PROVIDER reported for a completed turn —
 * the same number the server refuses on, so the two are the same number rather than two
 * readings of one scale. `contextState` therefore takes that measurement as an argument rather
 * than deriving it, and answers `null` for a conversation nobody has measured yet.
 *
 * The window numbers below are still twins of `backend/src/services/usage/limits.py`; change one
 * and change the other.
 */
import { getStoredUser } from './auth'
import type { ProfileLimits } from './auth'

/**
 * Twin of `limits.SYSTEM_PROMPT_RESERVE` — what a run costs before the citizen has typed
 * anything: the per-run system prompt and the tool schemas that ride with it.
 *
 * IT IS A SIZE, NOT A CHARGE, ON EITHER SIDE. Nothing holds it back any more — the provider's
 * count is of the whole prompt, system segment included, so there is nothing left to reserve
 * for. It survives because `UsersLimitsPanel` derives the lowest ceiling an administrator may
 * set from it, and that floor has to be the same number the server clamps to.
 */
export const SYSTEM_PROMPT_RESERVE = 8_000

/** Twins of `limits.DEFAULT_CONTEXT_SOFT` / `DEFAULT_CONTEXT_HARD`, used only when a session
 *  predates the profile carrying them. */
export const DEFAULT_CONTEXT_SOFT = 150_000
export const DEFAULT_CONTEXT_HARD = 200_000

// `Number.isInteger` is typed `(x: unknown) => boolean` rather than a predicate, so it does not
// narrow. This wraps the identical runtime check in a real one.
function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

/**
 * The signed-in user's effective thresholds. The login/refresh profile carries the
 * server-resolved `limits`; the constants above stand in when a session predates them.
 *
 * The `soft < hard` clamp mirrors the server's `effective_context` defensively — a warning that
 * sat AT the wall would fire for the first time in the same breath as the refusal, which is the
 * one moment it is no use.
 */
export function getContextLimits(): { soft: number; hard: number } {
  const limits: Partial<ProfileLimits> = getStoredUser()?.limits || {}
  const hard = isPositiveInt(limits.contextHardLimit) ? limits.contextHardLimit : DEFAULT_CONTEXT_HARD
  let soft = isPositiveInt(limits.contextSoftLimit) ? limits.contextSoftLimit : DEFAULT_CONTEXT_SOFT
  if (soft >= hard) soft = Math.max(1, hard - 1)
  return { soft, hard }
}

export interface ContextState {
  /** What the provider reported for this conversation, or null when nobody has measured it. */
  occupied: number | null
  soft: number
  hard: number
  /** Past the warn threshold — the one thing that drives any UI. */
  gettingLong: boolean
  /** The line shown when it is. Null the rest of the time, which is nearly always. */
  message: string | null
}

/**
 * Silent until it is useful, then one sentence — the same discipline `composerCap` follows.
 *
 * ══ IT IS HANDED A MEASUREMENT; IT DOES NOT TAKE ONE ══
 *
 * `occupied` is the token count the provider reported for a completed turn in this
 * conversation. `null` means nobody has measured it — a chat with no completed turn, or one
 * whose measurement has not reached the browser — and an unmeasured conversation is SILENT
 * rather than assumed full or assumed empty. Guessing is what this replaced.
 *
 * The wording names the action rather than the condition, because "start a new chat" is the
 * only thing the reader can do about it and nothing else here is theirs to act on. It says
 * their work survives for the same reason the server's refusal does: the reason someone
 * hesitates to start a new chat is the fear that the app goes with the conversation.
 */
export function contextState(occupied: number | null): ContextState {
  const { soft, hard } = getContextLimits()
  const gettingLong = occupied !== null && occupied >= soft
  return {
    occupied,
    soft,
    hard,
    gettingLong,
    message: gettingLong
      ? 'This chat is getting long. Start a new chat soon to keep things quick — your app and everything you have built stays exactly as it is.'
      : null,
  }
}
