/**
 * WHAT A WAIT LOOKS LIKE WHEN IT IS NOT ALLOWED TO MOVE.
 *
 * THE BUG THIS EXISTS TO CLOSE. `index.css`'s reduce-motion block sets `animation: none` on
 * `.animate-spin`, which is correct and stays. What it leaves behind is the problem: a `Loader2`
 * is a circular arrow with a gap in it — the universal "loading" glyph — and a STATIONARY one
 * does not read as "motion was suppressed", it reads as "this hung". So the portal's accommodation
 * turned every wait into a picture of a crash. Three components already branched on the
 * preference (`ToolActivityLine`, `OfferStrip`, `StopTurnControl`) and all three branched the
 * wrong way: they dropped `animate-spin` and kept the same frozen arrow.
 *
 * Reported from two Windows VMs, where animations are commonly switched off at the OS: a 40-second
 * save and a 76-second hand-over both presented as a dead modal. The citizen's own words were that
 * the application was stuck.
 *
 * THE FIX IS NOT MORE MOTION. Under the preference this renders no spinner at all — a glyph that
 * never claims to rotate cannot look stalled — and carries the wait on the one signal that needs
 * no animation to prove liveness: A NUMBER THAT GOES UP. Elapsed seconds is honest under both
 * registers, which is why it appears under motion too once a wait outlives `ELAPSED_AFTER_MS`.
 * A spinner says "working"; it cannot say "still working, and here is how long", and at seventy
 * seconds that is the only question the person in front of it has.
 *
 * WHY A SHARED PRIMITIVE RATHER THAN TWENTY EDITS. Twenty-three components render `animate-spin`
 * and each would have needed the same three lines, which is how the three that already had them
 * ended up disagreeing with the other twenty. One component, one behaviour, one place to correct.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Clock } from 'lucide-react'

function readReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Tracks `prefers-reduced-motion`; SSR/jsdom-safe (no matchMedia → false, i.e. animate). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    onChange()
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

/** How long a wait must run before its elapsed time is worth showing. Below this the number is
 *  noise on an interaction that already feels instant; above it, it is the whole answer. */
export const ELAPSED_AFTER_MS = 5_000

/**
 * Seconds since `active` last became true, ticking once a second; `0` whenever it is false.
 *
 * THE TIMER IS KEYED ON THE TRANSITION, not on mount: these live inside dialogs that stay mounted
 * across several steps of a hand-over, and a counter that kept climbing through all of them would
 * report the dialog's age rather than the step's. Cleared on the way down so a second press starts
 * from zero rather than resuming someone else's clock.
 */
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0)
  const startedAt = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      startedAt.current = null
      setSeconds(0)
      return undefined
    }
    startedAt.current = Date.now()
    setSeconds(0)
    const id = setInterval(() => {
      const from = startedAt.current
      if (from !== null) setSeconds(Math.floor((Date.now() - from) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [active])

  return seconds
}

/**
 * The glyph half, for the places that have room for an icon and nothing else — buttons, mostly.
 *
 * `aria-hidden` in BOTH registers. It is decoration either way; every caller already pairs it with
 * a label, and the label is what a screen reader should read.
 */
export function BusyGlyph({
  size = 15,
  className = '',
  testId,
}: {
  size?: number
  className?: string
  /** Forwarded as `data-testid`. Carried through BOTH registers on purpose: a suite that could
   *  only find the glyph while it span would go green on the very bug this module closes. */
  testId?: string
}): React.ReactElement {
  const reduced = usePrefersReducedMotion()
  // NOT a `Loader2` without its animation — that is precisely the frozen arrow this module exists
  // to stop rendering. A clock face is static BY NATURE, so nothing about it is waiting to move.
  if (reduced)
    return <Clock size={size} aria-hidden="true" data-testid={testId} className={`flex-shrink-0 ${className}`} />
  return (
    <Loader2
      size={size}
      aria-hidden="true"
      data-testid={testId}
      className={`flex-shrink-0 animate-spin ${className}`}
    />
  )
}

export interface WaitingLineProps {
  /** What is happening, in the caller's own words — "Saving it first…", "Putting it away…". */
  label: string
  /** Whether the wait is running. Drives the elapsed clock; the caller still decides to render. */
  active?: boolean
  className?: string
}

/**
 * Glyph, sentence and — once the wait has earned it — a live elapsed count.
 *
 * NO `role="status"` OF ITS OWN. Every caller today already sits inside a polite region it owns
 * (`ReclaimWorkspaceDialog`'s step line, `SaveControl`'s wait box), and nesting a second one is
 * how a sentence gets announced twice. The caller keeps the region; this fills it.
 *
 * The seconds are `tabular-nums` so the line does not reflow on every tick — a sentence that
 * jitters once a second is its own kind of broken.
 */
export function WaitingLine({
  label,
  active = true,
  className = '',
}: WaitingLineProps): React.ReactElement {
  const seconds = useElapsedSeconds(active)
  const show = seconds * 1000 >= ELAPSED_AFTER_MS
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <BusyGlyph size={14} className="text-primary" />
      <span>{label}</span>
      {show && (
        <span data-testid="waiting-elapsed" className="tabular-nums text-neutral/70">
          {seconds}s
        </span>
      )}
    </span>
  )
}
