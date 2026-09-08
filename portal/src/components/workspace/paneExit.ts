/**
 * THE PANE'S DEPARTURE, HELD OPEN LONG ENOUGH TO BE SEEN — the moment `T2Sliding` documents: the
 * app card slides out and fades while the conversation settles toward the middle; nothing about
 * the app is stopped or reloaded, it is only taken off screen.
 *
 * WHY THIS EXISTS: applying `animate-pane-leave` alone does nothing — the instant a surface stops
 * declaring the pane, the column goes to zero size and `visibility:hidden` in the same frame, and
 * an element that isn't rendered can't be watched fading. So the exit is a brief state of its own:
 * the column keeps its size, plays the keyframe, then collapses. `AppPane` owns this and hands the
 * answer down to `AppPaneHost` so the column and the frame inside it can't disagree. It's a TIMER,
 * not an `animationend` listener, because `prefers-reduced-motion` suppresses the animation in
 * `index.css` — `animationend` would never fire and the pane would stay forever; the cost is a
 * reduced-motion reader waits {@link PANE_EXIT_MS} for a layout change instead of getting it
 * instantly. Nothing unmounts or re-keys — same element throughout, only a class change, which is
 * what makes the movement safe over a live iframe.
 *
 * THE ACCESSIBILITY COST, AND HOW IT IS PAID: `visibility:hidden` takes the app out of the tab
 * order (see `hiddenSubtree.ts`) but can't apply while still being watched leave — an invisible
 * element has nothing to animate. So for {@link PANE_EXIT_MS} the app is `aria-hidden` (announced
 * gone) yet still Tab-reachable — a WCAG 4.1.2 violation. `inert` fixes it (out of the tab order
 * AND the a11y tree, while staying painted): `@types/react` 18 declares no such prop, but `inert`'s
 * own serialisation is the empty string, so {@link inertWhile} spreads it as a string-valued
 * unknown attribute — the one form TypeScript accepts without a cast. React 19 replaces this with
 * `inert={unreachable}` and the helper goes away.
 */
import { useEffect, useRef, useState } from 'react'

/**
 * How long the leaving column holds its size.
 *
 * IT MUST MATCH `pane-leave`'s duration in `tailwind.config.js` (0.24s). Two numbers, because a
 * keyframe's duration is not readable from JavaScript without measuring computed style — so this
 * one is written down beside the reason instead of derived.
 */
export const PANE_EXIT_MS = 240

/**
 * `inert` for as long as the pane is not part of the page — spread onto the element that already
 * carries `aria-hidden`, so "announced gone" and "out of reach" cannot drift apart.
 *
 * ABSENT RATHER THAN `inert={false}` when the pane is reachable, and that is not a style choice:
 * `inert` is a boolean attribute, so ANY value makes a subtree unreachable and `inert="false"`
 * would take the whole pane out of the tab order for good.
 */
export function inertWhile(unreachable: boolean): { inert?: '' } {
  return unreachable ? { inert: '' } : {}
}

/**
 * `true` for one animation's length after the pane stops being wanted, `false` otherwise.
 *
 * A pane that was never visible does not "leave", so a surface that mounts with no pane at all —
 * every plan chat opened cold, and the project screen before anything is built — goes straight to
 * its resting state with no animation and no delay.
 */
export function usePaneLeaving(visible: boolean): boolean {
  const [leaving, setLeaving] = useState(false)
  const was = useRef(visible)

  useEffect(() => {
    if (was.current === visible) return undefined
    was.current = visible
    if (visible) {
      // Coming back INTERRUPTS a departure: the return arm takes over from wherever the leave got
      // to, rather than waiting for a timer about a movement that is no longer happening.
      setLeaving(false)
      return undefined
    }
    setLeaving(true)
    const timer = window.setTimeout(() => setLeaving(false), PANE_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  return leaving
}
