/**
 * How a chat tells a write it can retry from one it cannot.
 *
 * "Could not save your message" is the right thing to say about a network blip and the
 * wrong thing to say about a project someone deleted in another tab — the first invites
 * a retry, the second makes retrying impossible. Both used to render identically.
 *
 * WHAT IS LEFT, AND WHY IT IS ONE PREDICATE. This module was mostly copy builders for two
 * surfaces that no longer exist: the composer's mode selector (a chat's kind is fixed when it
 * is created, so there is nothing to switch) and the client-side append route, whose two
 * opposite-meaning 409s this file was written to keep apart. That route is gone from the server
 * too — `message_seq_conflict` is a code the backend no longer sends anywhere — so the
 * distinction has no subject left to be right or wrong about. What survives is the one judgement
 * a live surface still makes: leave, or offer a retry.
 */
import { ApiError } from './apiError'
import { TurnStartError } from './turnStreamApi'

/**
 * The conversation (or the project it hangs off) no longer exists server-side. Retrying
 * cannot help; the chat must leave. Distinct from a save failure the user can recover from.
 *
 * TWO ERROR CLASSES, because this predicate now has TWO CALLERS reading TWO different
 * transports. It was written for `createBuild`'s REST call (`ApiError`); that call is retired,
 * and its 404 handling carried over into `fireRelayTurn`'s `startTurn` catch on the assumption
 * the same predicate would still recognise it. It would not have: `startTurn` throws
 * `TurnStartError`, never `ApiError`, so an unwidened check would have silently stopped firing
 * the moment the call it read moved — the exact "carried the treatment over, the shape changed
 * underneath it" bug this file exists to avoid. `TurnStartError` has no `ApiError` in its
 * prototype chain, so recognising it needs a second `instanceof` arm, not a supertype fix.
 */
export function isConversationGone(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 404
  if (err instanceof TurnStartError) return err.status === 404
  return false
}
