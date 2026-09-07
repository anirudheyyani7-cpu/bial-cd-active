/**
 * WHICH PROJECT A CHAT BELONGS TO, remembered per tab so the toolbar row can answer during the
 * one window where nothing else can.
 *
 * WHY THIS EXISTS: a chat's address is flat and permanent (`/chat/{id}`); its project is a
 * breadcrumb resolved from the conversation. A brand-new chat opens at
 * `/chat/{id}?projectId=…` and `ChatRoute` rewrites that away the instant the first message
 * lands — right for a shareable address, but it means the ordinary case (reload, bookmark, a
 * link into an existing chat) is a bare `/chat/{id}`: for the whole of `GET /conversations/{id}`
 * the row has no project to name and "Back to projects" sent the citizen out of the project
 * they were working in, from a control about to say something different a moment later.
 *
 * So the server's last answer is kept, keyed by chat, and stands in until it answers again —
 * never preferred over a live one (`ChatRoute` reads it only while resolution is still loading
 * and the URL carries nothing), so a chat that moved project shows the stale breadcrumb for one
 * fetch, no longer.
 *
 * `sessionStorage`, tab-scoped like the composer draft beside it — dies with the TAB, not the
 * sign-in (a sign-out/sign-in in the same tab keeps it, harmless: it's only a back target, and
 * the project read behind it is server-scoped to the signed-in user, so a stale id at worst
 * points one fetch at a 404). Access is wrapped because `sessionStorage` genuinely throws
 * (Safari private mode on quota, storage-blocking embeds) — the defined meaning of that failure
 * is "no memory," falling back to the neutral shape this row had before it existed.
 */

const key = (chatId: string): string => `chatProject:${chatId}`

/** The project this tab last saw the chat belong to, or `null` when it has never seen it. */
export function recallChatProject(chatId: string | null | undefined): string | null {
  if (!chatId) return null
  try {
    return sessionStorage.getItem(key(chatId))
  } catch {
    return null
  }
}

/** Record what the server (or the minting navigation) said, so the next load window can answer. */
export function rememberChatProject(
  chatId: string | null | undefined,
  projectId: string | null,
): void {
  if (!chatId || !projectId) return
  try {
    sessionStorage.setItem(key(chatId), projectId)
  } catch {
    // No memory this session. The row keeps the neutral shape during the load window.
  }
}
