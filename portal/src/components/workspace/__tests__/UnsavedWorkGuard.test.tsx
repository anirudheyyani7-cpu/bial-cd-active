/**
 * THE IN-PLACE UNSAVED-WORK GUARD.
 *
 * THE CASE THAT DECIDES WHETHER THIS FEATURE IS A NUISANCE: `null` has two causes, not one
 * claim. A check that RAN and could not answer is a real "we could not tell". A check that was
 * NEVER ASKED is not — `fetchSaveState` may only run on a live workspace, so a stopped project's
 * save state is permanently `null` with nothing to compare. Warning there fires on every exit
 * from every stopped project, the prompt-with-nothing-behind-it that teaches people to dismiss
 * prompts. Half of this file is that one distinction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, renderHook, act } from '@testing-library/react'
import { useUnsavedWorkGuard } from '../UnsavedWorkGuard'

const api = vi.hoisted(() => ({ saveProject: vi.fn() }))

vi.mock('../../../utils/buildSessionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/buildSessionApi')>()),
  saveProject: api.saveProject,
}))

interface Options {
  saveDirty: boolean | null
  workspaceIsAlive: boolean
  projectId?: string | null
  /** OMITTED ON PURPOSE by every scenario written before the fourth case existed: leaving it out
   *  is a caller that says nothing about a recovery copy, which must read as "there is none" and
   *  keep warning. A scenario that wants the recoverable case names an instant. */
  recoveryAt?: string | null
}

/** The guard, plus a control that exits through it — the shape the shell actually uses. */
function Harness({
  saveDirty,
  workspaceIsAlive,
  projectId = 'p1',
  recoveryAt,
  onLeave,
}: Options & { onLeave: () => void }) {
  const { guard, dialog } = useUnsavedWorkGuard({ saveDirty, workspaceIsAlive, projectId, recoveryAt })
  return (
    <>
      {dialog}
      <button type="button" onClick={() => guard(onLeave)}>
        leave the workspace
      </button>
    </>
  )
}

const leaveTheWorkspace = () => fireEvent.click(screen.getByRole('button', { name: /leave the workspace/i }))

beforeEach(() => {
  vi.clearAllMocks()
  api.saveProject.mockResolvedValue({ appId: 'a1', headSha: 'abc' })
})

afterEach(() => cleanup())

describe('an in-place exit with unsaved work warns before anything is discarded', () => {
  it('intercepts the navigation and says what is at stake', () => {
    const onLeave = vi.fn()
    render(<Harness saveDirty={true} workspaceIsAlive onLeave={onLeave} />)

    leaveTheWorkspace()

    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toMatch(/changes that are not saved yet/i)
  })

  it('lets a clean workspace through with no dialog at all', () => {
    const onLeave = vi.fn()
    render(<Harness saveDirty={false} workspaceIsAlive onLeave={onLeave} />)

    leaveTheWorkspace()

    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('★ the tri-state, and the fourth case', () => {
  it('warns on `null` WHILE ALIVE, and says the platform could not check', () => {
    const onLeave = vi.fn()
    render(<Harness saveDirty={null} workspaceIsAlive onLeave={onLeave} />)

    leaveTheWorkspace()

    const text = screen.getByRole('dialog').textContent ?? ''
    expect(onLeave).not.toHaveBeenCalled()
    expect(text).toMatch(/could not tell/i)
    // The one answer that costs somebody their work is a wrong reassurance.
    expect(text).not.toMatch(/nothing to lose/i)
    expect(text).not.toMatch(/everything is saved/i)
  })

  it('★ warns about NOTHING on a stopped project, where the check was never asked', () => {
    // THE FOURTH CASE. A stopped or never-built project's save state is permanently `null` because
    // `fetchSaveState` may only be called on a live workspace — not because a check failed.
    // Warning here would fire on every exit from every stopped project.
    //
    // Mutation receipt: drop `&& workspaceIsAlive` from the arming rule and this goes red.
    const onLeave = vi.fn()
    render(<Harness saveDirty={null} workspaceIsAlive={false} onLeave={onLeave} />)

    leaveTheWorkspace()

    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still warns on a definite `true` even when the workspace has stopped', () => {
    // The liveness gate applies to the UNKNOWN arm only. A definite yes is a definite yes.
    const onLeave = vi.fn()
    render(<Harness saveDirty={true} workspaceIsAlive={false} onLeave={onLeave} />)

    leaveTheWorkspace()

    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('the three ways out of the dialog', () => {
  it('save-then-leave saves first, then goes', async () => {
    const onLeave = vi.fn()
    render(<Harness saveDirty={true} workspaceIsAlive onLeave={onLeave} />)
    leaveTheWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /save and leave/i }))

    await waitFor(() => expect(onLeave).toHaveBeenCalledTimes(1))
    expect(api.saveProject).toHaveBeenCalledWith('p1')
  })

  it('★ a FAILED save keeps the person here and reports it', async () => {
    // Leaving anyway after promising to save first is the exact data loss this dialog exists to
    // prevent, arriving through the door marked "safe".
    const onLeave = vi.fn()
    api.saveProject.mockRejectedValue(new Error('Could not save your work'))
    render(<Harness saveDirty={true} workspaceIsAlive onLeave={onLeave} />)
    leaveTheWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /save and leave/i }))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not save your work')
    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    // …and the buttons are re-armed, so the dialog is not wedged.
    expect((screen.getByRole('button', { name: /save and leave/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('leave-anyway goes without saving', () => {
    const onLeave = vi.fn()
    render(<Harness saveDirty={true} workspaceIsAlive onLeave={onLeave} />)
    leaveTheWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /leave without saving/i }))

    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(api.saveProject).not.toHaveBeenCalled()
  })

  it('stay closes the dialog and goes nowhere', () => {
    const onLeave = vi.fn()
    render(<Harness saveDirty={true} workspaceIsAlive onLeave={onLeave} />)
    leaveTheWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /stay here/i }))

    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('takes focus on open, so a keyboard user learns it appeared', async () => {
    render(<Harness saveDirty={true} workspaceIsAlive onLeave={vi.fn()} />)
    leaveTheWorkspace()

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /stay here/i })))
  })

  it('offers no Save when there is no project to save into', () => {
    // The warning still fires — the work is real either way — but a Save button with nothing to
    // write is a control whose only outcome is an error.
    render(<Harness saveDirty={true} workspaceIsAlive projectId={null} onLeave={vi.fn()} />)
    leaveTheWorkspace()

    expect(screen.queryByRole('button', { name: /save and leave/i })).toBeNull()
    expect(screen.getByRole('button', { name: /leave without saving/i })).toBeTruthy()
  })
})

describe('★ the exit is held, not called — the silent-updater trap', () => {
  it('does not run the exit at the moment it is handed over', () => {
    // `setPending(go)` calls `go` IMMEDIATELY, because React treats a function argument to a setter
    // as an updater. The navigation simply happens, guard and all, and the dialog never appears —
    // a failure with no error and no visible symptom other than the guard doing nothing.
    const onLeave = vi.fn()
    const { result } = renderHook(() =>
      useUnsavedWorkGuard({ saveDirty: true, workspaceIsAlive: true, projectId: 'p1' }),
    )

    act(() => result.current.guard(onLeave))

    expect(onLeave).not.toHaveBeenCalled()
    expect(result.current.dialog).not.toBeNull()
  })

  it('runs the SAME exit that was handed over, not a stale one', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { result } = renderHook(() =>
      useUnsavedWorkGuard({ saveDirty: true, workspaceIsAlive: true, projectId: 'p1' }),
    )

    act(() => result.current.guard(first))
    act(() => result.current.guard(second))

    render(<>{result.current.dialog}</>)
    fireEvent.click(screen.getByRole('button', { name: /leave without saving/i }))

    // The most recent intent wins: a person who pressed one link and then another is going to the
    // second one, and a guard that ran the first would send them somewhere they did not ask for.
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})

/**
 * ★ THE FOURTH CASE OF THE ARMING RULE — a `true` the platform is holding a copy of.
 *
 * `dirty` answers "is there a saved VERSION of this tree?", so THE BUILD ITSELF makes it true: a
 * citizen who described an app, watched the platform build it and touched nothing arrives at
 * `dirty: true, savedHead: null` — and this guard stopped them on their way out over work they had
 * never done. `recoveryAt` is what tells that apart from real loss, because every automatic
 * restore goes through `SessionManager.newest_restore_source` and that hands back the RECOVERY
 * copy, not the saved one.
 *
 * WHAT THESE FIVE HOLD BETWEEN THEM is that the carve-out is narrow. Exactly one situation stops
 * warning; the other four go on warning exactly as they did, which is what keeps this from
 * becoming "never warn about anything".
 */
describe('★ a `true` the platform can put back is not a warning', () => {
  const RECOVERY_INSTANT = '2026-09-10T10:38:43Z'

  it('★ lets a freshly built app out with no dialog at all — THE REPORTED BUG', () => {
    // The exact reading from the report: `{dirty: true, savedHead: null, recoveryAt: <instant>}`.
    //
    // MUTATION RECEIPT: put the arm back to `if (saveDirty === true) return true` and this case
    // alone goes red — every other case in this file stays green, which is what proves the new
    // clause is load-bearing and no wider than the bug it closes.
    const onLeave = vi.fn()
    render(<Harness saveDirty={true} workspaceIsAlive recoveryAt={RECOVERY_INSTANT} onLeave={onLeave} />)

    leaveTheWorkspace()

    // The exit RAN — which is also this assertion's liveness check, since a harness that threw
    // would leave `onLeave` uncalled and the `toBeNull()` below true for the wrong reason.
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('★ STILL warns on a `true` with no recovery copy — real unsaved work did not become invisible', () => {
    // The assertion that stops the fix from being "never warn about anything". A citizen who has
    // been working in a container the platform is holding nothing for is exactly who this dialog
    // was written for, and they must still be stopped.
    const onLeave = vi.fn()
    render(<Harness saveDirty={true} workspaceIsAlive recoveryAt={null} onLeave={onLeave} />)

    leaveTheWorkspace()

    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toMatch(/changes that are not saved yet/i)
  })

  it('★ warns when the caller says NOTHING about a recovery copy', () => {
    // A call site that has not been updated passes no instant at all, and the default must not
    // quietly disarm the guard for it: absent is not the same claim as "there is a copy". This is
    // the direction the fact is allowed to fail in, and it is the only one.
    const onLeave = vi.fn()
    render(<Harness saveDirty={true} workspaceIsAlive onLeave={onLeave} />)

    leaveTheWorkspace()

    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('a recovery copy does NOT quiet the could-not-tell arm', () => {
    // The question that went unanswered was whether the container holds anything at all. Knowing
    // a copy exists says nothing about that, and the honest dialog is still the one that says so.
    const onLeave = vi.fn()
    render(<Harness saveDirty={null} workspaceIsAlive recoveryAt={RECOVERY_INSTANT} onLeave={onLeave} />)

    leaveTheWorkspace()

    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toMatch(/could not tell/i)
  })

  it('and it does not wake the never-asked arm either', () => {
    // A stopped project was never asked the question, so there is still nothing to warn about —
    // a recovery instant beside it changes neither half of that.
    const onLeave = vi.fn()
    render(
      <Harness saveDirty={null} workspaceIsAlive={false} recoveryAt={RECOVERY_INSTANT} onLeave={onLeave} />,
    )

    leaveTheWorkspace()

    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
