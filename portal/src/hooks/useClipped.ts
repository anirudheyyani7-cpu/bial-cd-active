/**
 * Is this element's text ACTUALLY clipped? Measured after layout (character heuristics are
 * wrong at every breakpoint), and re-measured on resize plus on `document.fonts.ready` —
 * `ResizeObserver` does not fire for a content-only width change with an unchanged box, so a
 * measurement taken before a `display=swap` font swap can pin `clipped` wrong for the
 * element's whole lifetime. Shared: `ProjectRow`/`ProjectCard` both need it (round-4).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export function useClipped<T extends HTMLElement>(text: string | null) {
  const ref = useRef<T>(null)
  const [clipped, setClipped] = useState(false)

  const measure = useCallback(() => {
    const el = ref.current
    if (el) setClipped(el.scrollWidth > el.clientWidth)
  }, [])

  useEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [measure, text])

  useEffect(() => {
    // Guarded rather than assumed: jsdom does not implement the Font Loading API at all in
    // some versions, and a real browser without it simply has no swap to chase.
    const ready = typeof document !== 'undefined' ? document.fonts?.ready : undefined
    if (!ready) return
    let cancelled = false
    ready.then(() => {
      if (!cancelled) measure()
    })
    return () => {
      cancelled = true
    }
  }, [measure])

  return { ref, clipped }
}
