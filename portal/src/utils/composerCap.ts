/**
 * THE BROWSER'S CHARACTER CAP.
 *
 * WHY THIS EXISTS
 * NOTHING IS EVER TRUNCATED: over the cap the text STAYS — all of it — and Send is marked
 * unavailable with one line saying why. The HTML `maxLength` attribute is never set, and that is
 * the requirement rather than a detail: someone whose paste was quietly cut believes their whole
 * specification went in, and the app that gets built is missing the half nobody knows was
 * dropped. The acceptance criteria forbid the attribute by name, and a test asserts its absence.
 *
 * THE GAP TO THE SERVER IS DELIBERATE AND ALREADY WIDE: the browser stops at 10,000; the server
 * REFUSES — does not trim — at 64,000 (`MAX_MESSAGE_TEXT_CHARS`), returning a 422 with nothing
 * stored. Six times the headroom means a message that passes here cannot plausibly be refused
 * there, so the two limits never disagree in front of a citizen. This module does not change the
 * server's number.
 *
 * THE COUNTER IS ALLOWED TO BE SILENT: the honest answer to "show a live count" turned out to be
 * no. The server counts CHARACTERS the way Python does — one per Unicode code point — but
 * JavaScript's `String.length` counts UTF-16 code UNITS, so any character above the basic
 * multilingual plane (an emoji, a script above U+FFFF) makes the browser's number silently
 * diverge from the server's. `countCharacters` counts CODE POINTS instead, so a number we show
 * agrees with the server — but agreement is only half of it: a counter is a promise the number
 * means something, and near a limit a wrong number is worse than no number. We show the count
 * only once the reader is close enough to the cap for it to matter, and the number shown is the
 * one the server would compute.
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
 *
 * `[...text].length` iterates code points, so an astral-plane character (an emoji, an ancient
 * script, a rare CJK ideograph) counts once here and once on the server. `text.length` would count
 * it twice and the two numbers would drift apart with no way for a reader to tell which was
 * lying.
 *
 * A combining mark IS its own code point and counts separately in both places — "é" written as
 * `e` + U+0301 is two characters to the server and two here. That is agreement, which is what the
 * requirement asks for, even though it is not what a reader would guess by counting glyphs.
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
