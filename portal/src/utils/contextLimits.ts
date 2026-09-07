/**
 * THE BROWSER'S "THIS CHAT IS GETTING LONG" WARNING.
 *
 * WHY THIS EXISTS. The hard boundary is the SERVER's (`enforce_context_limit` refuses the
 * turn before anything persists) — the two-page portal once enforced the whole guardrail in
 * the browser, so when `ChatPage.tsx` was deleted the boundary went with it: an administrator
 * set a number nothing read, and a citizen's first news of the limit was a failed turn with
 * no reason. A guard only the client holds is not a guard. So this file only warns EARLY
 * ENOUGH to finish a thought and start a new chat, never refuses.
 *
 * THE ESTIMATE IS A FLOOR: the browser sees rendered prose/attachments, the server also
 * counts every tool call/result a Build turn generated, so this number can only under-count.
 * It carries the same `SYSTEM_PROMPT_RESERVE` and token ratio the server holds, so it never
 * claims room the server would refuse. Every constant below twins one in
 * `backend/src/services/usage/` (`context_window.py` / `limits.py`) — change one, change both.
 */
import { getStoredUser } from './auth'
import type { ProfileLimits } from './auth'
import type { ChatMessage } from './messageTypes'

/** Twin of `context_window.CHARS_PER_TOKEN`. */
export const CHARS_PER_TOKEN = 4

/**
 * Twin of `context_window.NOMINAL_BINARY_TOKENS`. An IMAGE is worth roughly a thousand tokens
 * however many megabytes it is, so it is charged flat. Its byte length is the wrong number by
 * orders of magnitude.
 *
 * It used to cover PDFs too, and that is what #194 measured going wrong: a 61-page document
 * really cost 153,342 tokens against a 1,600 charge. Documents now have their own number below.
 */
export const NOMINAL_BINARY_TOKENS = 1_600

/**
 * Twin of `context_window.NOMINAL_PDF_TOKENS`, and the two MUST move together — this file's own
 * rule, stated at the top: they are two readings of one scale.
 *
 * A flat charge sized to the largest document the upload cap admits (30 pages at a measured
 * ~2,514 tokens a page), so the browser's warning cannot sit further from the wall than the
 * server's refusal does. Charging a document the image nominal put the browser 47x under the
 * server: a citizen would watch a comfortable meter and then be refused mid-sentence, which is
 * the exact failure the twin rule exists to prevent.
 */
export const NOMINAL_PDF_TOKENS = 75_000

/** Twin of `context_window.PDF_MEDIA_TYPE` — the one media type charged as a document. */
export const PDF_MEDIA_TYPE = 'application/pdf'

/**
 * Twin of `limits.SYSTEM_PROMPT_RESERVE` — room for the per-run system prompt, which
 * neither side can see from here. Carried in the browser's number too so the warning cannot sit
 * further from the wall than the refusal does.
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

/**
 * What this conversation is worth, in tokens, as far as the browser can see. EVERY attachment
 * counts on EVERY turn — a real change from the estimator this replaces, which charged
 * image/PDF parts only in the newest message. The turn engine rehydrates every stored
 * attachment on every turn (Foundry has no Files API), so charging once would under-count.
 * Office attachments count by extracted TEXT: a 200 KB spreadsheet is ~50k tokens, not 1,600.
 */
export function estimateConversationTokens(messages: readonly ChatMessage[]): number {
  let tokens = 0
  for (const message of messages) {
    for (const part of message?.parts || []) {
      if (part?.type === 'text') {
        tokens += Math.ceil((part.text || '').length / CHARS_PER_TOKEN)
      } else if (part?.type === 'file' && part.kind === 'office') {
        tokens += Math.ceil((part.text || '').length / CHARS_PER_TOKEN)
      } else if (part?.type === 'file') {
        // SPLIT BY MEDIA TYPE, exactly as `_tokens_in` does on the server: a document costs
        // orders of magnitude more than an image and the two must not share a number. Anything
        // that is neither falls to the image nominal — the smaller and more common shape, and
        // the same fallback the server takes.
        tokens += part.mediaType === PDF_MEDIA_TYPE ? NOMINAL_PDF_TOKENS : NOMINAL_BINARY_TOKENS
      }
      // Everything else — plan cards, steps, build banners — is chrome the browser draws, not
      // content the model is sent. The server's own measurement never sees them either.
    }
  }
  return tokens + SYSTEM_PROMPT_RESERVE
}

export interface ContextState {
  /** The browser's floor estimate, reserve included. */
  estimate: number
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
 * The wording names the action rather than the condition, because "start a new chat" is the
 * only thing the reader can do about it and nothing else here is theirs to act on. It says
 * their work survives for the same reason the server's refusal does: the reason someone
 * hesitates to start a new chat is the fear that the app goes with the conversation.
 */
export function contextState(messages: readonly ChatMessage[]): ContextState {
  const { soft, hard } = getContextLimits()
  const estimate = estimateConversationTokens(messages)
  const gettingLong = estimate >= soft
  return {
    estimate,
    soft,
    hard,
    gettingLong,
    message: gettingLong
      ? 'This chat is getting long. Start a new chat soon to keep things quick — your app and everything you have built stays exactly as it is.'
      : null,
  }
}
