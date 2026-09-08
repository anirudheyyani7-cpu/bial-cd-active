/**
 * The composer draft, per conversation — THE ONE STORE, FOR BOTH CHAT KINDS.
 *
 * WHY THIS EXISTS: under the mode-free composer contract the user can keep typing while the
 * assistant works, so the text must survive a reload and a chat switch. Both kinds use it now —
 * planning used to keep its text in assistant-ui's in-memory composer, which cleared on every
 * chat change including the first mount after a reload, so a planning draft died on reload and on
 * a round trip to a sibling chat. This module is the sole owner of the key; other surfaces only
 * consume it, so there is exactly one writer per key.
 *
 * SEMANTICS, stated because they are user-visible:
 *  - `sessionStorage`, not `localStorage`: a draft is tab-scoped work-in-progress, and dying with
 *    the tab is correct, rather than accumulating every abandoned half-thought forever.
 *  - Keyed per conversation, so switching chats shows each one its own draft.
 *  - LAST WRITER WINS across tabs sharing one conversation — accepted deliberately; the
 *    alternative is a merge UI for a text box.
 *  - Cleared on a SUCCESSFUL send only, never on failure — a failed send is exactly when the text
 *    is worth most, and clearing it would resend the same message by accident.
 *
 * Storage access is wrapped because `sessionStorage` genuinely throws rather than degrading
 * (Safari private mode on quota, storage-blocking embeds) — losing a draft is not worth taking
 * the chat down with it.
 */

const key = (conversationId: string): string => `draft:${conversationId}`

/** The saved draft, or `''` when there is none (or storage is unavailable). */
export function readDraft(conversationId: string | null | undefined): string {
  if (!conversationId) return ''
  try {
    return sessionStorage.getItem(key(conversationId)) ?? ''
  } catch {
    return ''
  }
}

/**
 * THE ONE WRITE, AND CLEARING IS A CASE OF IT. An empty string removes the key rather than storing
 * a blank, so "the box emptied" and "the box now holds this" are the same statement — which is
 * what keeps the stored copy and the visible box from disagreeing after a send.
 */
export function writeDraft(conversationId: string | null | undefined, text: string): void {
  if (!conversationId) return
  try {
    if (text) sessionStorage.setItem(key(conversationId), text)
    else sessionStorage.removeItem(key(conversationId))
  } catch {
    // No persistence this session. The composer still holds the text in React state.
  }
}
