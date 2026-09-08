/**
 * ToolActivityLine — the shared atom for build/tool activity, reached through `ActivityRow`
 * (a step) and `ActivityGroup`'s glyph strip (collapsed summary) so live and reloaded builds
 * never visually diverge. (Formerly `BuildProgress`/`BuilderPage`'s shared atom; both were
 * deleted with the two-page era.)
 *
 * Chrome-free flex row: `[state glyph 14px] label`, constant height. FAILED conveys by glyph
 * SHAPE (cross) plus a visually-hidden "failed" — never colour alone (WCAG 1.4.1). Spinner
 * gated behind `prefers-reduced-motion`. Palette: portal CUSTOM tokens (`text-danger`/
 * `text-primary`/`text-tertiary`), not shadcn's — keeps rows matching the transcript's colours.
 */
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { assertNever } from '../../utils/assertNever'

/** Live steps are started/ok/failed; reloaded steps are ok/failed/pending — the atom spans both. */
export type ToolActivityState = 'started' | 'pending' | 'ok' | 'failed'

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

function StateGlyph({ state, reduced }: { state: ToolActivityState; reduced: boolean }) {
  switch (state) {
    case 'ok':
      return <CheckCircle2 size={14} aria-hidden="true" className="flex-shrink-0 text-green-600" />
    case 'failed':
      return <XCircle size={14} aria-hidden="true" className="flex-shrink-0 text-danger" />
    case 'started':
      return (
        <Loader2
          size={14}
          aria-hidden="true"
          className={cn('flex-shrink-0 text-primary', !reduced && 'animate-spin')}
        />
      )
    case 'pending':
      return <Loader2 size={14} aria-hidden="true" className="flex-shrink-0 text-neutral/40" />
    default:
      return assertNever(state)
  }
}

export interface ToolActivityLineProps {
  label: string
  state: ToolActivityState
  className?: string
}

export function ToolActivityLine({ label, state, className }: ToolActivityLineProps) {
  const reduced = usePrefersReducedMotion()
  return (
    <span
      // `relative` contains the sr-only "failed" span: sr-only is position:absolute with no
      // inset, so without a positioned ancestor it anchors to the DOCUMENT and lands ~11,000px
      // down a long transcript, stretching the page (measured 11,558px vs an 836px viewport).
      className={cn('relative inline-flex w-full items-center gap-2 text-xs text-tertiary', className)}
      data-kind="tool-activity"
      data-state={state}
    >
      <StateGlyph state={state} reduced={reduced} />
      <span className="min-w-0 truncate">{label}</span>
      {/* Failure carried as TEXT, not colour alone (WCAG 1.4.1) — the label stays neutral. */}
      {state === 'failed' && <span className="sr-only">failed</span>}
    </span>
  )
}
