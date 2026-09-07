/**
 * The waiting-count badge — how many apps sit in the review queue. It exists as ONE component,
 * not two spans, because it appears in two places (the admin nav entry and the panel's Pending
 * tab) which must never disagree about the number or how it's announced.
 *
 * ACCESSIBILITY: the visible numeral is `aria-hidden`; the real accessible name is the
 * visually-hidden "N apps waiting for review" beside it, so the count is announced once, with
 * its meaning, not twice without it.
 *
 * ZERO AND `null` BOTH RENDER NOTHING: an empty queue has nothing to say (a "0" badge would
 * train an administrator to ignore this pixel), and an unknown count must never claim a number.
 */

interface Props {
  /** The pending count, or `null` when it is unknown (not yet fetched, or the fetch failed). */
  count: number | null
  /** Distinguishes the two mounts in the DOM (`nav`, `tab`) — one testid each. */
  where: string
}

/** The accessible sentence. Singular is not pedantry — "1 apps waiting" is the kind of
 *  thing that makes a person trust the rest of the screen slightly less. */
// Module-local now that the bell that called it is gone, its only outside caller. Still
// used by the badge's own sr-only label below, so it stays a function — it just stops
// advertising itself as part of this module's surface.
function waitingForReviewLabel(count: number): string {
  return `${count} ${count === 1 ? 'app' : 'apps'} waiting for review`
}

export default function WaitingCountBadge({ count, where }: Props) {
  if (count === null || count <= 0) return null
  return (
    <span
      data-testid={`waiting-count-${where}`}
      // `relative` contains the sr-only sentence: sr-only is position:absolute, so
      // without a positioned ancestor it would anchor to the page and drag the badge's
      // layout with it (the same trap `ToolActivityLine` documents).
      className="relative inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-danger text-white text-[10px] font-bold leading-none"
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{waitingForReviewLabel(count)}</span>
    </span>
  )
}
