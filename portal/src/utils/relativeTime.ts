/**
 * "2 days ago" — a pure date formatter, with no module it drags along.
 *
 * It lived in `chatHistory.ts`, which is not a formatting module: importing anything from
 * there runs `createConversationStore('plan')` at module scope. That is invisible until
 * something outside chat wants a timestamp — the projects list (#158) — and then a project
 * row cannot render without a chat store existing, which is both wrong and the kind of
 * coupling that only shows up as a confusing test failure.
 *
 * So the function moved here. It was briefly re-exported from `chatHistory` for continuity,
 * but #175 retired that module's chat list along with the re-export — this docblock outlived
 * it by a round and claimed a link that no longer existed (round-4 review).
 *
 * TWO WORDINGS, ONE SET OF BUCKETS, and that is the whole reason `elapsed` is separate.
 * The projects list wants the abbreviated form in a dense column (`12d ago`); the admin
 * review queue wants the spelled-out one, because "43 days ago" is the sentence that makes a
 * backlog's depth land (#209). #209 shipped its own copy of the bucketing first — the plan
 * had checked for an existing ABSOLUTE formatter and found one, and never thought to look for
 * a relative one. The two copies also disagreed at the edges: this one floors `ms / 60000`
 * directly, that one rounded to whole seconds first and then floored the ratio, so the same
 * instant could read `59m ago` here and `1 hour ago` there. One bucketer now, two wordings.
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago `isoString` was, bucketed to the coarsest unit that still reads as a duration.
 * `null` means "less than a minute" — the one case both wordings spell as a phrase rather than
 * a count, so neither caller has to invent a zero.
 *
 * Never negative: a clock skew that puts a stored timestamp slightly in the future reads as
 * "just now" rather than as a count backwards.
 */
function elapsed(isoString: string): { count: number; unit: 'minute' | 'hour' | 'day' } | null {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000))
  if (secs < MINUTE) return null
  if (secs < HOUR) return { count: Math.floor(secs / MINUTE), unit: 'minute' }
  if (secs < DAY) return { count: Math.floor(secs / HOUR), unit: 'hour' }
  return { count: Math.floor(secs / DAY), unit: 'day' }
}

/** A short relative time for a dense column: `just now`, `5m ago`, `3h ago`, `12d ago`. */
export function relativeTime(isoString: string): string {
  const ago = elapsed(isoString)
  if (ago === null) return 'just now'
  return `${ago.count}${ago.unit[0]} ago`
}

/**
 * The same instant, spelled out and pluralised: `just now`, `1 minute ago`, `43 days ago`.
 *
 * NO NULL ARM, DELIBERATELY. Callers hand this a timestamp something else has already vouched
 * for (`fmtWhen` in the review queue's case). An age counted from a missing value would be
 * fifty-odd years since the epoch — the same "1/1/1970" lie in a different unit — so the
 * question of whether an age exists at all stays with the caller that can answer it.
 */
export function relativeTimeVerbose(isoString: string): string {
  const ago = elapsed(isoString)
  if (ago === null) return 'just now'
  return `${ago.count} ${ago.unit}${ago.count === 1 ? '' : 's'} ago`
}
