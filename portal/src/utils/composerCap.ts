/**
 * THE BROWSER'S CHARACTER CAP.
 *
 * WHY THIS EXISTS
 * NOTHING IS EVER TRUNCATED: over the cap the text stays, all of it, and Send is marked
 * unavailable instead. The HTML `maxLength` attribute is never set — that is the acceptance
 * criterion, pinned by a test asserting its absence — because a paste quietly cut leaves
 * someone believing their whole specification went in.
 *
 * THE GAP TO THE SERVER IS DELIBERATE: the browser stops at 10,000; the server REFUSES
 * (never trims) at 64,000 (`MAX_MESSAGE_TEXT_CHARS`), returning a 422 with nothing stored.
 * Six times the headroom means a message that passes here cannot plausibly be refused there.
 *
 * THE COUNTER STAYS SILENT until near the cap: the server counts Unicode CODE POINTS the way
 * Python does, but JS's `String.length` counts UTF-16 code units, so any character above the
 * basic multilingual plane makes the browser's naive count diverge from the server's.
 * `countCharacters` counts code points instead — showing it only near the cap means a wrong
 * number is never shown when it wouldn't matter, and a shown number always agrees with the
 * server's.
 */

/** The browser's cap. Six times below the server's 64,000-character refusal, deliberately. */
export const MAX_COMPOSER_CHARS = 10_000

/**
 * Show the counter only inside this many characters of the cap.
 *
 * A permanent counter on an empty box is noise; one that appears as you approach a limit is
 * information. It is also the range where being exactly right matters, which is why the count is
 * code points rather than `String.length`.
 */
export const COUNTER_VISIBLE_WITHIN = 1_000

/**
 * Count the way the server counts: one per code point, not per UTF-16 code unit.
 * `[...text].length` iterates code points, so an astral-plane character (emoji, rare
 * ideograph) counts once here and once on the server; `text.length` would count it twice and
 * the two numbers would drift. A combining mark ("é" as `e` + U+0301) is its own code point
 * and counts separately in both places — agreement, even though it is not glyph count.
 */
export function countCharacters(text: string): number {
  return [...text].length
}

export interface CapState {
  /** The server-comparable count. */
  count: number
  /** Over the cap: the text stays, Send goes unavailable. */
  over: boolean
  /** Whether a number is worth showing at all. */
  showCounter: boolean
  /** The one line shown when Send is unavailable because of length. */
  message: string | null
}

export function capState(text: string): CapState {
  const count = countCharacters(text)
  const over = count > MAX_COMPOSER_CHARS
  return {
    count,
    over,
    showCounter: count >= MAX_COMPOSER_CHARS - COUNTER_VISIBLE_WITHIN,
    message: over
      ? `That is longer than one message can carry. Nothing has been cut — shorten it to ${MAX_COMPOSER_CHARS.toLocaleString()} characters, or send it in two.`
      : null,
  }
}
