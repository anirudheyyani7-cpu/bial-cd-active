/**
 * The composer draft, per conversation — THE ONE STORE, FOR BOTH CHAT KINDS.
 *
 * WHY THIS EXISTS
 * Under the mode-free composer contract the user can keep typing while the assistant works, so
 * the text has to survive a reload, a chat switch, and a refinement chip — the first two are
 * this module's job. Both chat kinds use it now: the planning surface used to keep its text in
 * assistant-ui's in-memory composer and clear it on every chat change including the first mount
 * after a reload, so a planning draft died on a reload and on a round trip to a sibling chat.
 * This module is the sole owner of the key — other surfaces only consume it and never write
 * directly — so there is exactly one writer per key.
 *
 * SEMANTICS, stated because they are user-visible:
 *  - `sessionStorage`, not `localStorage`: a draft is tab-scoped work-in-progress, and dying with
 *    the tab is the correct lifetime, rather than accumulating every abandoned half-thought
 *    forever across every conversation.
 *  - Keyed per conversation, so switching chats shows each one its own draft rather than leaking
 *    one conversation's text into another.
 *  - LAST WRITER WINS across tabs sharing one conversation; accepted deliberately, since the
 *    alternative is a merge UI for a text box.
 *  - Cleared on a SUCCESSFUL send, never on failure — a failed send is exactly when the text is
 *    worth most, and an uncleared draft would otherwise resend the same message by accident.
 *
 * Storage access is wrapped because `sessionStorage` genuinely throws rather than degrading —
 * Safari's private mode on quota, and any embedding that blocks storage access. Losing a draft is
 * not worth taking the chat down with it: no persistence, everything else unaffected.
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
