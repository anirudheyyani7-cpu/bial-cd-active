/**
 * The one banner slot above the composer.
 *
 * WHY A SLOT AND NOT A LIST: five sentences the platform may need to say arrive in the same place,
 * and a list stacks into a wall where the one that still matters is indistinguishable from ones
 * already overtaken. NEWEST WINS — each describes the app's state NOW, so the component takes ONE
 * value, making that a type property rather than a rule call sites must remember. ABOVE THE
 * COMPOSER, NOT IN THE TRANSCRIPT: each sentence ends in an action, and a message that scrolls
 * away takes its next action with it. `withMailtoLinks` linkifies HERE, not in the copy, because
 * the server's sentence also reaches DOM-less surfaces where a `mailto:` URI is the jargon
 * `copy.py` keeps out. Announced POLITELY: actions, not alarms.
 */
import type { ReactElement } from 'react'

/** An email address, stopping before a trailing full stop — or the `mailto:` would carry the
 *  sentence's punctuation into the mailbox name. */
const AN_EMAIL_ADDRESS = /[^\s<>@]+@[^\s<>@.]+(?:\.[^\s<>@.]+)+/g

/**
 * The sentence with its support address turned into a real `mailto:` link.
 *
 * RE-HOMED FROM `BuildProgress.tsx` TO ITS ONE REMAINING READER: it was exported there because
 * the at-limit row and this banner rendered the same server sentence; the row is gone with the
 * card, so this slot is the only DOM it reaches now.
 *
 * THE ADDRESS ARRIVES AS TEXT — a division of labour, not an oversight: the server owns the
 * words, and a `mailto:` URI spelled out mid-sentence is exactly the register `copy.py` exists
 * to keep out. Making it clickable is a rendering concern, so it happens where there is a DOM.
 *
 * Returns React nodes, never a markup string: the sentence is server copy today, but a renderer
 * that interprets its input as HTML is one config change from an injection sink — a risk nothing
 * here needs.
 */
export function withMailtoLinks(text: string): (string | ReactElement)[] {
  const out: (string | ReactElement)[] = []
  let cursor = 0
  // `matchAll` starts a fresh iteration each call — the regex is module-level and `g`-flagged, so
  // reusing `exec` across calls would carry `lastIndex` between renders and drop links at random.
  for (const match of text.matchAll(AN_EMAIL_ADDRESS)) {
    const at = match.index
    if (at > cursor) out.push(text.slice(cursor, at))
    out.push(
      <a
        key={`${at}-${match[0]}`}
        href={`mailto:${match[0]}`}
        className="font-semibold underline underline-offset-2"
      >
        {match[0]}
      </a>,
    )
    cursor = at + match[0].length
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

interface TurnBannerProps {
  /** The sentence to show, or `null` for nothing. One value: newest wins by construction. */
  text: string | null
}

export default function TurnBanner({ text }: TurnBannerProps) {
  // THE LIVE REGION WRAPS THE BOX AND IS ALWAYS MOUNTED; the box is what appears and disappears.
  // Inserting a region together with its text announces inconsistently — several reader and
  // browser combinations miss it entirely — so the element has to be in the accessibility tree
  // BEFORE the text arrives. The preview pane already learned this the hard way and keeps a
  // permanent region for the same reason.
  //
  // WRAPPING rather than a second `sr-only` copy, which is what this was first written as: two
  // elements carrying the same sentence is one sentence rendered twice as far as anything reading
  // the DOM is concerned, and it broke three existing tests that look the banner up by its text.
  // A duplicate is also a real hazard on its own — the next person to add a visual tweak has two
  // places to change and no reason to suspect the second.
  return (
    <div role="status" aria-live="polite">
      {text ? (
        <div
          data-testid="turn-banner"
          className="text-[11px] text-danger bg-danger/5 border border-danger/20 rounded-lg px-2.5 py-1.5"
        >
          {withMailtoLinks(text)}
        </div>
      ) : null}
    </div>
  )
}
