/**
 * "2 days ago" — a pure date formatter, with no module it drags along.
 *
 * It lived in `chatHistory.ts`, which runs `createConversationStore('plan')` at module scope —
 * invisible until something outside chat (the projects list) wants a timestamp, and importing
 * it would spin up a chat store just to render a project row. The function moved here; the
 * `chatHistory` re-export it once kept for continuity is gone too. Today's one caller is the
 * projects list's "Details updated" column.
 */

/** A short relative time: `just now`, `5m ago`, `3h ago`, `12d ago`. */
export function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
