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
import { BusyGlyph } from '../ui/Waiting'
import { cn } from '@/lib/utils'
import { assertNever } from '../../utils/assertNever'

/** Live steps are started/ok/failed; reloaded steps are ok/failed/pending — the atom spans both. */
export type ToolActivityState = 'started' | 'pending' | 'ok' | 'failed'


function StateGlyph({ state }: { state: ToolActivityState }) {
  switch (state) {
    case 'ok':
      return <CheckCircle2 size={14} aria-hidden="true" className="flex-shrink-0 text-green-600" />
    case 'failed':
      return <XCircle size={14} aria-hidden="true" className="flex-shrink-0 text-danger" />
    case 'started':
      // A RUNNING step, and the one glyph on this line that has to prove it is still running.
      // `BusyGlyph` owns both motion registers — including the one where the answer is NOT a
      // motionless copy of the spinner, which is what this arm used to render.
      return <BusyGlyph size={14} className="text-primary" />
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
  return (
    <span
      // `relative` contains the sr-only "failed" span: sr-only is position:absolute with no
      // inset, so without a positioned ancestor it anchors to the DOCUMENT and lands ~11,000px
      // down a long transcript, stretching the page (measured 11,558px vs an 836px viewport).
      className={cn('relative inline-flex w-full items-center gap-2 text-xs text-tertiary', className)}
      data-kind="tool-activity"
      data-state={state}
    >
      <StateGlyph state={state} />
      <span className="min-w-0 truncate">{label}</span>
      {/* Failure carried as TEXT, not colour alone (WCAG 1.4.1) — the label stays neutral. */}
      {state === 'failed' && <span className="sr-only">failed</span>}
    </span>
  )
}
