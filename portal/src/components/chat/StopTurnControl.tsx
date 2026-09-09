/**
 * STOP, MOVED TO WHERE THE COMPOSER IS. The two arms are not a mode branch — they discriminate on
 * whether a TURN ID EXISTS (a transport fact): a turn build stops via the turn endpoint with its
 * conversation/turn ids, a legacy build session (no turn id) stops via the session. Force-end
 * deliberately did NOT move — a turn build has no force-end equivalent, and a kill switch that
 * confirms "this kills in-progress work" and then does nothing is worse than none. The accessible
 * name is stable: the old button flipped "Stop" → "Stopping…" mid-interaction; the word stays
 * "Stop" in every state, with the in-flight state carried by the glyph and `title` instead. Mounted
 * by `Composer`, so reachable in both kinds of chat.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Square } from 'lucide-react'
import { BusyGlyph } from '../ui/Waiting'

/** The live turn to stop: which conversation, and which turn within it. */
export interface StopTarget {
  conversationId: string
  turnId: string
}

export interface StopTurnControlProps {
  /** A turn — or a legacy build session — is running. No run, no control: this renders `null`. */
  running: boolean
  /**
   * Resolve the live turn AT PRESS TIME, returning `null` when there is no turn id — a legacy
   * build session, not an error. A getter rather than a plain `turnId` prop is not ceremony: the
   * surface holds the live turn id in a ref because the stop handler is created once and would
   * otherwise close over whichever turn was live at its first render — a prop read during render
   * reintroduces that staleness one layer up, silently (stopping the previous turn, or falling to
   * the session arm early). Reading at press time is the only version that cannot be stale.
   */
  resolveTarget: () => StopTarget | null
  /**
   * Stop the live turn, with the conversation id and turn id `resolveTarget` returned.
   *
   * The resolved value is deliberately `unknown`: `stopTurn` answers `"stopping"` or
   * `"already_settled"` and `session.stop()` answers a boolean. This control cares only that the
   * request SETTLED — a rejection is the failure, and "already settled" is a perfectly good
   * outcome for someone who pressed Stop as the turn was finishing anyway.
   */
  onStopTurn: (conversationId: string, turnId: string) => Promise<unknown>
  /** Stop a legacy build session, which has no turn id. */
  onStopSession: () => Promise<unknown>
  /**
   * A stop request failed. The caller decides where the sentence lands — the surface
   * consolidates those onto its assertive slot. What this component guarantees is that a
   * failure is never silent and never leaves a dead button.
   */
  onStopFailed: (message: string) => void
}

const STOP_FAILED = 'Could not stop this. Try again.'

export default function StopTurnControl({
  running,
  resolveTarget,
  onStopTurn,
  onStopSession,
  onStopFailed,
}: StopTurnControlProps) {
  const [stopping, setStopping] = useState(false)

  // A stop request outlives the control: the turn ends, `running` flips false, this unmounts, and
  // the promise then settles. Without this the state update lands on a dead component.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const handleStop = useCallback(async () => {
    // The enforcement, and the whole of it. A second press while one is in flight is a no-op —
    // `aria-disabled` only says so. `ComposerBox` owns why it is never a real `disabled`.
    if (stopping) return
    setStopping(true)
    try {
      const target = resolveTarget()
      if (target) await onStopTurn(target.conversationId, target.turnId)
      else await onStopSession()
    } catch {
      onStopFailed(STOP_FAILED)
    } finally {
      if (mounted.current) setStopping(false)
    }
  }, [stopping, resolveTarget, onStopTurn, onStopSession, onStopFailed])

  if (!running) return null

  return (
    <button
      type="button"
      onClick={handleStop}
      aria-disabled={stopping}
      title={stopping ? 'Stopping — this can take a moment.' : undefined}
      data-testid="stop-turn"
      className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-bial-border bg-white px-2.5 py-1 text-xs font-semibold text-tertiary transition ${
        stopping ? 'opacity-50 cursor-default' : 'hover:border-primary hover:text-primary'
      }`}
    >
      {stopping ? <BusyGlyph size={12} /> : <Square size={12} />}
      Stop
    </button>
  )
}
