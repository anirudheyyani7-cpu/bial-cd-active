/**
 * WHY THIS EXISTS: the half `beforeunload` cannot cover.
 *
 * Two guards already exist: a hoisted `beforeunload` for leaving the TAB, and the
 * server-driven reclaim dialog for another project taking the workspace. Unguarded: an
 * in-place navigation OUT of the workspace (navbar links, breadcrumb, opening another
 * project) while unsaved work exists and no 409 is involved — a same-page navigation is
 * not an unload, so `beforeunload` never fires for it.
 *
 * THE ARMING RULE. `beforeunload` stays armed only on a definite `true` — its prompt has
 * fixed text, so arming it on "we could not check" trains people to dismiss prompts. This
 * in-app dialog CAN carry a reason, so it also warns on `null` — but `null` has TWO causes:
 * (1) the check ran and could not answer, or (2) it was NEVER ASKED, because `fetchSaveState`
 * only runs on a live workspace, so a stopped/never-built project is permanently `null` with
 * nothing to check. Warning on case 2 would fire on every exit from every stopped project —
 * the exact prompt-with-nothing-behind-it the rule exists to avoid. So: warn on `true`; warn
 * on `null` ONLY while alive; never on `false`; never when not running.
 *
 * Uses confirm-before-navigate, not `useBlocker`: that needs a data router and the app is on
 * `BrowserRouter` — migrating for one hook is out of scope; the workspace's own exits are
 * served by an exit function the shell's chrome consults instead.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { BusyGlyph, useElapsedSeconds, ELAPSED_AFTER_MS } from '../ui/Waiting'
import { saveProject } from '../../utils/buildSessionApi'

export interface UnsavedWorkGuardHandle {
  /**
   * Run `go` — unless there is something to lose, in which case ask first and run it only if the
   * person says so. Every in-place exit from the workspace routes through this ONE function; a
   * control that navigates directly is a control this guard cannot see.
   */
  guard: (go: () => void) => void
  dialog: React.ReactElement | null
}

export interface UnsavedWorkGuardOptions {
  /** TRI-STATE. `true` definitely dirty, `false` definitely clean, `null` no claim. */
  saveDirty: boolean | null
  /** Whether the workspace is running. A `null` from a stopped project means "never asked". */
  workspaceIsAlive: boolean
  /** The project a Save would write. `null` disables the save-then-leave arm, not the warning. */
  projectId: string | null
  /**
   * WHOSE WORK IS AT RISK, or `null` when the caller cannot say.
   *
   * "This app has changes that are not saved yet" is ambiguous the moment a citizen has more than
   * one project — and the two exits this dialog covers, the navbar and the back control, are
   * exactly the ones taken while thinking about a different app. Naming it costs one prop and
   * removes the ambiguity entirely.
   */
  projectName?: string | null
}

/** Is there anything a person could lose by leaving right now? */
function worthWarningAbout(saveDirty: boolean | null, workspaceIsAlive: boolean): boolean {
  if (saveDirty === true) return true
  // `null` while ALIVE is a check that ran and could not answer, so the platform says so.
  // `null` while not alive is a check nobody asked, which is not the same claim at all.
  return saveDirty === null && workspaceIsAlive
}

export function useUnsavedWorkGuard({
  saveDirty,
  workspaceIsAlive,
  projectId,
  projectName = null,
}: UnsavedWorkGuardOptions): UnsavedWorkGuardHandle {
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const guard = useCallback(
    (go: () => void) => {
      if (!worthWarningAbout(saveDirty, workspaceIsAlive)) {
        go()
        return
      }
      // Stored as a thunk INSIDE a setter callback: `setPending(go)` would call `go` immediately,
      // because React treats a function argument as an updater. The bug is silent — the navigation
      // simply happens, guard and all.
      setError(null)
      setPending(() => go)
    },
    [saveDirty, workspaceIsAlive],
  )

  const leave = useCallback(() => {
    const go = pending
    setPending(null)
    go?.()
  }, [pending])

  const saveThenLeave = useCallback(async () => {
    if (!projectId) return
    setSaving(true)
    setError(null)
    try {
      await saveProject(projectId)
      if (!mounted.current) return
      leave()
    } catch (err) {
      if (!mounted.current) return
      // A SAVE THAT FAILED MUST NOT LET THE NAVIGATION THROUGH. Leaving anyway after promising to
      // save first is the exact data loss this dialog exists to prevent, arriving through the door
      // marked "safe".
      setError(err instanceof Error ? err.message : 'Could not save your work. Try again.')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }, [projectId, leave])

  const dialog = pending ? (
    <UnsavedWorkDialog
      projectName={projectName}
      certain={saveDirty === true}
      saving={saving}
      error={error}
      canSave={projectId !== null}
      onSaveAndLeave={() => void saveThenLeave()}
      onLeaveAnyway={leave}
      onStay={() => setPending(null)}
    />
  ) : null

  return { guard, dialog }
}

interface DialogProps {
  /** Whose work is at risk, or `null` when the caller cannot say. */
  projectName: string | null
  /** `true` = we know there are unsaved changes; `false` = we could not check and say so. */
  certain: boolean
  saving: boolean
  error: string | null
  canSave: boolean
  onSaveAndLeave: () => void
  onLeaveAnyway: () => void
  onStay: () => void
}

/**
 * HAND-ROLLED, MATCHING `ReclaimWorkspaceDialog`: has `aria-modal`/`aria-labelledby`,
 * Escape/overlay-click to stay (inert mid-save), initial focus on Stay — but no focus trap or
 * scroll lock, so Tab can walk out into the page behind it.
 * Worth closing, since this is the last guard on someone's unsaved work; `components/ui/dialog.tsx`
 * (Radix, see `AttachmentPreview.tsx`) is the upgrade path, left separate so this change doesn't
 * also move real behaviour. `ReclaimWorkspaceDialog` stays the copy/focus-park pattern either way.
 */
function UnsavedWorkDialog({
  certain,
  saving,
  error,
  canSave,
  onSaveAndLeave,
  onLeaveAnyway,
  onStay,
  projectName,
}: DialogProps) {
  const subject = projectName ? `“${projectName}”` : 'This app'
  const subjectLower = projectName ? `“${projectName}”` : 'this app'
  // A save here is the same 40-second write the hand-over dialog performs, against the same
  // container — so it needs the same honest wait. See `ui/Waiting.tsx` for why a spinner alone
  // is not one, and why this number appears under motion as well as without it.
  const elapsed = useElapsedSeconds(saving)
  const showElapsed = elapsed * 1000 >= ELAPSED_AFTER_MS
  const stayRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    stayRef.current?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 font-manrope"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-work-title"
    >
      <div className="absolute inset-0 bg-black/40" onClick={saving ? undefined : onStay} />
      <div
        className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !saving) onStay()
        }}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-bial-bg">
            <AlertTriangle size={17} className="text-warning" />
          </div>
          <h3 id="unsaved-work-title" className="text-base font-bold text-tertiary">
            {certain ? 'Save your changes before you go?' : 'We could not check for unsaved changes'}
          </h3>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-neutral">
          {/* NAMED WHERE THE CALLER KNOWS IT. "This app" is ambiguous the moment
              somebody has more than one project, and both exits this dialog covers are taken
              while thinking about a different one. Falls back to the old phrasing rather than
              rendering an empty pair of quotes. */}
          {certain
            ? `${subject} has changes that are not saved yet. Save them and they come back exactly as you left them; leave without saving and they go.`
            : // Say that the platform could not tell, rather than reporting there is nothing
              // to lose. A wrong reassurance is the one answer that costs somebody their work.
              `We could not tell whether ${subjectLower} has unsaved changes. Saving first is the safe option.`}
        </p>

        {error && (
          <p role="alert" className="mt-3 text-sm leading-relaxed text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-2.5">
          {canSave && (
            <button
              type="button"
              disabled={saving}
              onClick={onSaveAndLeave}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <BusyGlyph size={15} /> : null} Save and leave
              {showElapsed && <span className="tabular-nums opacity-80">{elapsed}s</span>}
            </button>
          )}
          <button
            type="button"
            disabled={saving}
            onClick={onLeaveAnyway}
            className="w-full rounded-xl border border-bial-border py-2.5 text-sm font-semibold text-tertiary transition hover:bg-bial-bg disabled:cursor-not-allowed disabled:opacity-50"
          >
            Leave without saving
          </button>
          <button
            ref={stayRef}
            type="button"
            disabled={saving}
            onClick={onStay}
            className="w-full rounded-xl py-2 text-sm font-semibold text-neutral transition hover:text-tertiary disabled:opacity-50"
          >
            Stay here
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * THE ONE EXIT FUNCTION, provided by the shell, consulted by the workspace's chrome. A
 * CONTEXT, NOT A PROP — structural: navbar/breadcrumb exits aren't this guard's descendants
 * (navbar is a sibling of the grid, and renders on workspace-less pages too), so a prop
 * would force every such page to pass a guard it doesn't have. `null` OUTSIDE A WORKSPACE IS
 * ORDINARY, not an error — `useWorkspaceExit` then hands back a function that just goes,
 * leaving every other page's navigation unchanged.
 */
const WorkspaceExitContext = createContext<((go: () => void) => void) | null>(null)

export const WorkspaceExitProvider = WorkspaceExitContext.Provider

/** Run an exit through the workspace's guard, or straight through when there is none. */
export function useWorkspaceExit(): (go: () => void) => void {
  const guard = useContext(WorkspaceExitContext)
  return guard ?? runStraightThrough
}

const runStraightThrough = (go: () => void) => go()
