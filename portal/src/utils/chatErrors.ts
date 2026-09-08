/**
 * How a chat tells a write it can retry from one it cannot.
 *
 * "Could not save your message" is right for a network blip, wrong for a project someone
 * deleted in another tab — the first invites a retry, the second makes retrying impossible.
 * Both used to render identically.
 *
 * WHAT SURVIVES, AND WHY ONE PREDICATE: copy builders for two retired surfaces — the mode
 * selector (a chat's kind is fixed at creation) and the client-side append route, whose two
 * opposite-meaning 409s it kept apart (`message_seq_conflict` is a code the backend no longer
 * sends) — leaving the one judgement a live surface still makes: leave, or offer a retry.
 */
import { ApiError } from './apiError'
import { TurnStartError } from './turnStreamApi'

/**
 * The conversation (or its project) no longer exists server-side — retrying cannot help, the
 * chat must leave, distinct from a recoverable save failure.
 * TWO `instanceof` ARMS, not one: written for `createBuild`'s `ApiError`, then carried into
 * `startTurn`'s catch on the same-check assumption — wrong, since `startTurn` throws
 * `TurnStartError`, which has no `ApiError` in its prototype chain. Each transport needs its
 * own arm; a shared-supertype check would silently stop firing for this one.
 */
export function isConversationGone(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 404
  if (err instanceof TurnStartError) return err.status === 404
  return false
}
