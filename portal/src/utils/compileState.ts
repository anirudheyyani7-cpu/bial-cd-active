/**
 * What the app's dev server is compiling right now — the signal the preview pane covers its
 * frame with. FOUR values, and the fourth is the whole point: `unknown` means the platform has
 * no idea (HMR socket not yet connected, down between reconnects, an older image, or a failed
 * transport) — it must NEVER read as `clean`, or the pane uncovers itself over the exact error
 * screen it exists to hide. Mirrors `CompileState` in `backend/src/services/sandbox/base.py`.
 *
 * The settle debounce before a `clean` publishes lives ONLY in the container
 * (`_COMPILE_DEBOUNCE_S`, `sandbox/supervisor/app.py`) — this side keeps no copy and runs no
 * timer of its own, so the cover-clear delay stays one number in one place.
 */
export type CompileState = 'building' | 'clean' | 'failed' | 'unknown'

/** Narrow a wire value to a `CompileState`. Anything unrecognised is `unknown`, never a guess. */
export function asCompileState(value: unknown): CompileState {
  return value === 'building' || value === 'clean' || value === 'failed' ? value : 'unknown'
}
