/**
 * THE READ BEHIND THE WORKSPACE STATE (Plan F, U2) — the half that talks to the server.
 *
 * Two of this plan's own scenarios depend on a timer EXISTING, not merely on the map being right:
 * a `starting` read has to reach `running` with no user gesture, and a stay that lapses at thirty
 * minutes has to be noticed rather than left on screen as a lie. So the cadence is asserted here
 * directly, with fake timers, rather than left as an implementation detail.
 *
 * The other half of this file is about COST. `fetchPreviewState` is cheap by contract — one cache
 * read, no container call — and safe on a timer. `fetchSaveState` runs two `git` executions inside
 * the container, and asking a stopped project whether it has unsaved work is a start the screen
 * caused. The gating is a requirement (R3), not an optimisation, so it is pinned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PreviewState, SaveState } from '../../../utils/buildSessionApi'

const api = vi.hoisted(() => ({
  fetchPreviewState: vi.fn(),
  fetchSaveState: vi.fn(),
  fetchCompileState: vi.fn(),
  checkWorkspace: vi.fn(),
}))

vi.mock('../../../utils/buildSessionApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/buildSessionApi')>()
  return { ...actual, ...api }
})

const { useWorkspaceState } = await import('../useWorkspaceState')
const {
  BACKGROUND_CADENCE,
  PREVIEW_PROBE_MS,
  STARTING_PROBE_LIMIT,
  STARTING_PROBE_MS,
  nextProbeCadence,
} = await import('../workspaceState')

function reading(over: Partial<PreviewState> = {}): PreviewState {
  return {
    state: 'asleep',
    alive: false,
    previewUrl: null,
    occupyingProjectName: null,
    occupyingProjectId: null,
    restorable: null,
    ...over,
  }
}

const SAVE: SaveState = { appId: 'app-1', dirty: false, containerHead: 'abc1234', savedHead: 'abc1234' }

/** The hook, mounted against a project, with the defaults every scenario shares. */
const mount = (projectId: string | null = 'proj-1', projectHasSavedBuild: boolean | null = null) =>
  renderHook(() => useWorkspaceState({ projectId, projectHasSavedBuild }))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  for (const fn of Object.values(api)) fn.mockReset()
  api.fetchPreviewState.mockResolvedValue(reading())
  api.fetchSaveState.mockResolvedValue(SAVE)
})

afterEach(() => {
  vi.useRealTimers()
})

/** Let the in-flight read settle without leaning on a wall clock. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('the read runs where the old probe would not', () => {
  it('asks with NO framed URL — the no-frame case is what the pane exists to describe', async () => {
    // The conversation surface's probe returns early on `!framedPreviewUrl`, which is right for a
    // pane catching a framed app being reclaimed underneath it and exactly wrong here: a project
    // whose app is saved and not running has no address at all, and it is the state that carries
    // the product's one start control.
    mount()
    await settle()

    expect(api.fetchPreviewState).toHaveBeenCalledWith('proj-1')
  })

  it('asks nothing at all while the route has not resolved a project', async () => {
    mount(null)
    await settle()

    expect(api.fetchPreviewState).not.toHaveBeenCalled()
  })
})

describe('the cadence — the timer two features depend on', () => {
  it('reaches running from starting with NO user gesture', async () => {
    api.fetchPreviewState.mockResolvedValueOnce(reading({ state: 'starting' }))
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'alive', alive: true }))

    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('starting'))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS + 1)
    })

    expect(result.current.state.name).toBe('running')
  })

  it('notices the stay lapsing under a person who is still reading', async () => {
    // `RELAUNCH_PREVIEW_STAY_SECONDS` is granted at relaunch and extended only by a turn's own
    // deadline writers; start-then-read has no turn. The pane must return to "Your app is saved."
    // with the start offered — one press to recover — rather than showing a dead frame.
    api.fetchPreviewState.mockResolvedValueOnce(reading({ state: 'alive', alive: true }))
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'asleep', restorable: true }))

    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('running'))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS + 1)
    })

    expect(result.current.state.name).toBe('not-running')
    expect(result.current.state.action?.kind).toBe('start')
  })

  it('stops asking on a settled answer whose restore question was decided', async () => {
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'asleep', restorable: true }))
    mount()
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalledTimes(1))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS * 3)
    })

    expect(api.fetchPreviewState).toHaveBeenCalledTimes(1)
  })

  it('keeps asking while `restorable` is still null — a half answer is not terminal', async () => {
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'asleep', restorable: null }))
    mount()
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalledTimes(1))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS + 1)
    })

    expect(api.fetchPreviewState.mock.calls.length).toBeGreaterThan(1)
  })

  it('re-asks on a deliberate refresh, which no batching can erase', async () => {
    const { result } = mount()
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalledTimes(1))

    await act(async () => {
      result.current.refresh()
    })
    await settle()

    expect(api.fetchPreviewState).toHaveBeenCalledTimes(2)
  })
})

/**
 * #203 — THE PANE LEAVES "GETTING YOUR APP READY." WHEN THE APP IS READY.
 *
 * The measurement in the issue: the server flipped to `alive` at t=2.7s and the pane left
 * `starting` at t=45.5s, with nothing animating for the 42.8 seconds in between — so there was no
 * cue that it was not simply hung. `starting` is the only reading whose successor arrives with no
 * gesture from anybody, which is exactly why a cadence tuned for "has anything happened while
 * nobody was looking" is the wrong instrument for it.
 *
 * WHAT THESE SCENARIOS PIN, beyond "it is faster now": the acceleration is bounded at both ends.
 * It is gated STRICTLY on `starting` and reverts on anything else (or the whole product ends up on
 * a three-second poll), and it gives up after a fixed number of reads (or a start that hangs polls
 * for the life of the tab). And it never reclassifies the wait it gives up on — the pane still
 * says a start is happening, because that is still what is true. Reading an elapsed budget as a
 * statement about the container is the mistake in
 * `docs/solutions/logic-errors/readiness-timeout-triggers-destructive-sandbox-restore-2026-08-02.md`.
 */
describe('the accelerated cadence while a start is in flight (#203)', () => {
  it('leaves `starting` within ONE accelerated read, not one background cadence', async () => {
    api.fetchPreviewState.mockResolvedValueOnce(reading({ state: 'starting' }))
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'alive', alive: true }))

    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('starting'))

    // Three seconds, not forty-five. At the old cadence nothing has fired by here at all, so the
    // pane is still telling somebody their running app is being prepared.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS + 1)
    })

    expect(result.current.state.name).toBe('running')
  })

  it('reverts to the background cadence the moment the reading is not `starting`', async () => {
    api.fetchPreviewState.mockResolvedValueOnce(reading({ state: 'starting' }))
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'alive', alive: true }))

    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('starting'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS + 1)
    })
    expect(result.current.state.name).toBe('running')
    const settled = api.fetchPreviewState.mock.calls.length

    // TEN accelerated intervals over a running workspace buy nothing. The mutation this pins is a
    // window that stays open on `alive`, which puts every idle project screen in the product on a
    // three-second poll — the request volume the issue's fix is explicitly not allowed to change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS * 10)
    })
    expect(api.fetchPreviewState.mock.calls.length).toBe(settled)

    // ABSENCE, PAIRED WITH LIVENESS: the timer above is quiet because it is slow, not because it
    // is dead — one background cadence later it asks again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS)
    })
    expect(api.fetchPreviewState.mock.calls.length).toBe(settled + 1)
  })

  it('gives up the accelerated window after the bound — WITHOUT reclassifying the wait', async () => {
    // A start that never readies. The server holds `starting` for up to five minutes
    // (`STARTING_MARKER_TTL_SECONDS`), so this is a real answer and not a fault.
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'starting' }))

    const { result } = mount()
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalledTimes(1))

    // The whole window, read by read: the mount read plus exactly the bound.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS * STARTING_PROBE_LIMIT)
    })
    const spent = api.fetchPreviewState.mock.calls.length
    expect(spent).toBe(1 + STARTING_PROBE_LIMIT)

    // Past it, ten more accelerated intervals buy nothing — the fast timer is gone…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS * 10)
    })
    expect(api.fetchPreviewState.mock.calls.length).toBe(spent)

    // …and the sentence is UNCHANGED. A budget elapsing is a fact about our waiting, not about the
    // container: no "gone", no "try again", no verb that assumes the workspace is dead.
    expect(result.current.state.name).toBe('starting')
    expect(result.current.state.action).toBeNull()

    // And the background poll is still there to correct the pane if the app lands two minutes late.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS)
    })
    expect(api.fetchPreviewState.mock.calls.length).toBeGreaterThan(spent)
  })

  it('changes cadence WITHOUT re-running the effect, so the pane cannot blink', async () => {
    // THE PATH IS THE SUBJECT, not the destination. The tempting implementation — put
    // `preview.state` in the effect's dependency list — arrives at `running` too, and gets there
    // by tearing the poll down and building it again mid-start. That is forbidden here for a
    // reason this file already states ("a start outcome must not restart the poll"), it costs an
    // extra request on every transition, and on the chat surface, whose equivalent effect DOES
    // blank its reading on every re-run, the same mutation flickers the pane through "we could not
    // check" and — since #192 — unframes an app that is running
    // (`ConversationSurface-cadence.test.jsx` holds that half, where the damage is visible).
    //
    // So both halves are asserted: the READ COUNT, which is what a re-armed effect gives itself
    // away by, and the sequence of states, which is what a reader would have seen.
    //
    // ★ AND THE ANSWERS MUST ARRIVE LATE ENOUGH TO BE SEEN AROUND, which is what gives this test
    // its teeth. With `mockResolvedValue` — and, verified here, even with a `setTimeout(…, 0)` — the
    // dep-driven mutant is INERT: the answer lands in the same flush as the effect's own
    // `setPreview(null)`, React coalesces the two into one commit, and the blank verdict is never
    // rendered at all. A real network takes tens of milliseconds, so the `null` commit lands FIRST
    // and the flicker is on screen. Answering half a second later is the difference between this
    // guard and a green test that proves nothing. (Same trap, same fix, as
    // `ConversationSurface-previewaddress.test.tsx`'s loop guard, one flush deeper.)
    const ANSWERS_IN = 500
    const seen: string[] = []
    const later = (value: PreviewState) =>
      new Promise<PreviewState>((resolve) => {
        setTimeout(() => resolve(value), ANSWERS_IN)
      })
    api.fetchPreviewState.mockImplementationOnce(() => later(reading({ state: 'starting' })))
    api.fetchPreviewState.mockImplementation(() => later(reading({ state: 'alive', alive: true })))

    renderHook(() => {
      const held = useWorkspaceState({ projectId: 'proj-1', projectHasSavedBuild: null })
      seen.push(held.state.name)
      return held
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANSWERS_IN + 1)
    })
    expect(seen).toContain('starting')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS + ANSWERS_IN * 2)
    })

    // Before the first read lands there is genuinely nothing to say, and "could not read" is the
    // honest answer to a question nobody has answered yet — so the sequence is read from the first
    // real verdict onward.
    // TWO READS AND NO MORE: the mount's, and the accelerated tick that found the app serving. A
    // third is an effect that re-armed itself, which is the mutation this pins.
    expect(api.fetchPreviewState).toHaveBeenCalledTimes(2)
    const published = seen.slice(seen.indexOf('starting'))
    expect(published).not.toContain('could-not-read')
    expect(published.at(-1)).toBe('running')
  })

  it('the own-press short-circuit still asks exactly once more, and leaves ONE timer behind', async () => {
    // `ProjectWorkspace`'s `onStartOutcome(null)` calls `refresh()` so a start that reached the app
    // lands on the press rather than on a tick. It bumps the epoch, so the effect tears down and
    // re-runs — and a cadence change that failed to clear the interval it replaced would double
    // every read from here on, invisibly, for the life of the tab.
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'starting' }))

    const { result } = mount()
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalledTimes(1))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS + 1)
    })
    expect(api.fetchPreviewState).toHaveBeenCalledTimes(2)

    await act(async () => {
      result.current.refresh()
    })
    await settle()
    expect(api.fetchPreviewState).toHaveBeenCalledTimes(3)

    // ONE accelerated interval, ONE read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS + 1)
    })
    expect(api.fetchPreviewState).toHaveBeenCalledTimes(4)
  })

  it('spends no container call to go faster — the acceleration buys cheap reads only', async () => {
    // `fetchSaveState` is two `git` executions INSIDE the container, and it fires on the tick that
    // first sees `alive` — which, in an accelerated window, is a container that came up seconds
    // ago and is still unpacking a snapshot and booting a dev server.
    api.fetchPreviewState.mockResolvedValueOnce(reading({ state: 'starting' }))
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'alive', alive: true }))

    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('starting'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTING_PROBE_MS + 1)
    })

    // ABSENCE: the accelerated read found a live app and asked it nothing…
    expect(result.current.state.name).toBe('running')
    expect(api.fetchSaveState).not.toHaveBeenCalled()

    // …and LIVENESS: the next background tick asks, which is no later than it would have asked
    // without the acceleration at all.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS)
    })
    expect(api.fetchSaveState).toHaveBeenCalledWith('proj-1')
  })
})

/**
 * The cadence decision on its own, for the two rules the hook scenarios above cannot reach without
 * an unreliable server to play against.
 */
describe('nextProbeCadence — what opens a window, what closes it, what spends it', () => {
  it('a blip mid-start does not drop the reader back to the background wait', () => {
    const open = nextProbeCadence('starting', BACKGROUND_CADENCE)
    expect(open).toEqual({ delayMs: STARTING_PROBE_MS, fastReads: 1 })

    // `unknown` decided nothing, and the readers already refuse to let it overwrite the verdict on
    // screen. Letting it close the window would put the pane back on a 45-second wait over a
    // sentence that still says a start is happening — the bug, restored by a network hiccup.
    const blip = nextProbeCadence('unknown', open)
    expect(blip.delayMs).toBe(STARTING_PROBE_MS)
    // …but it SPENDS from the window. The bound is on reads made, not on answers we liked: a
    // server answering `unknown` forever must not buy an unbounded fast poll.
    expect(blip.fastReads).toBe(2)
  })

  it('an `unknown` on its own never opens a window', () => {
    expect(nextProbeCadence('unknown', BACKGROUND_CADENCE)).toEqual(BACKGROUND_CADENCE)
  })

  it.each(['alive', 'asleep', 'slot_taken', 'never_built'] as const)(
    'a decided "%s" closes the window and gives the next start a whole one',
    (state) => {
      expect(nextProbeCadence(state, { delayMs: STARTING_PROBE_MS, fastReads: 7 })).toEqual(
        BACKGROUND_CADENCE,
      )
    },
  )

  it('stops accelerating at the bound and never counts past it', () => {
    const exhausted = nextProbeCadence('starting', {
      delayMs: STARTING_PROBE_MS,
      fastReads: STARTING_PROBE_LIMIT,
    })
    expect(exhausted.delayMs).toBe(PREVIEW_PROBE_MS)
    expect(exhausted.fastReads).toBe(STARTING_PROBE_LIMIT)
  })
})

describe('what an unreadable answer may and may not do', () => {
  it('an `unknown` after a decided `asleep` leaves the decided value in place', async () => {
    // A blip must not pull a running app off screen, and it must not wipe a settled answer
    // somebody is already reading either.
    api.fetchPreviewState.mockResolvedValueOnce(reading({ state: 'asleep', restorable: true }))
    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('not-running'))

    api.fetchPreviewState.mockResolvedValue(reading({ state: 'unknown' }))
    await act(async () => {
      result.current.refresh()
    })
    await settle()

    expect(result.current.state.name).toBe('not-running')
  })

  it('a read that throws says nothing and leaves the timer running', async () => {
    api.fetchPreviewState.mockResolvedValueOnce(reading({ state: 'starting' }))
    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('starting'))

    api.fetchPreviewState.mockRejectedValue(new Error('network'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS + 1)
    })

    expect(result.current.state.name).toBe('starting')
  })

  it('records "could not read" when it is the ONLY thing we know', async () => {
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'unknown' }))
    const { result } = mount()

    await waitFor(() => expect(result.current.state.name).toBe('could-not-read'))
    expect(result.current.state.action?.kind).toBe('retry')
  })
})

describe('cost — the calls this hook refuses to make (R3)', () => {
  it('never asks a stopped workspace whether it has unsaved work', async () => {
    // Two `git` execs against a dead container is an attach the screen caused.
    for (const state of ['asleep', 'never_built', 'slot_taken', 'starting', 'unknown'] as const) {
      api.fetchSaveState.mockClear()
      api.fetchPreviewState.mockResolvedValue(reading({ state, restorable: true }))
      const { result, unmount } = mount()
      await waitFor(() => expect(result.current.preview?.state).toBe(state))
      await settle()
      expect(api.fetchSaveState, `save state asked while ${state}`).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('asks for the save state only once the workspace is alive', async () => {
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'alive', alive: true }))
    const { result } = mount()

    await waitFor(() => expect(result.current.save).toEqual(SAVE))
    expect(api.fetchSaveState).toHaveBeenCalledWith('proj-1')
  })

  it('drops the save state the moment the workspace stops being alive', async () => {
    // Holding a reading from a container that has since stopped would arm the unsaved-work guard
    // against work that is no longer reachable.
    api.fetchPreviewState.mockResolvedValueOnce(reading({ state: 'alive', alive: true }))
    const { result } = mount()
    await waitFor(() => expect(result.current.save).toEqual(SAVE))

    api.fetchPreviewState.mockResolvedValue(reading({ state: 'asleep', restorable: true }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_PROBE_MS + 1)
    })

    expect(result.current.save).toBeNull()
  })

  it('treats an unreadable save state as no claim rather than as clean', async () => {
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'alive', alive: true }))
    api.fetchSaveState.mockRejectedValue(new Error('exec failed'))
    const { result } = mount()

    await waitFor(() => expect(result.current.state.name).toBe('running'))
    await settle()
    expect(result.current.save).toBeNull()
  })

  it('never calls the two container-exec reads that belong to a live turn', async () => {
    api.fetchPreviewState.mockResolvedValue(reading({ state: 'alive', alive: true }))
    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('running'))
    await settle()

    expect(api.fetchCompileState).not.toHaveBeenCalled()
    expect(api.checkWorkspace).not.toHaveBeenCalled()
  })
})

describe('the start outcome slot', () => {
  it('renders the reported ending and clears it on request', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.state.name).toBe('never-built'))

    await act(async () => {
      result.current.reportStartOutcome({ kind: 'timed-out' })
    })
    expect(result.current.state.name).toBe('timed-out')

    await act(async () => {
      result.current.reportStartOutcome(null)
    })
    expect(result.current.state.name).toBe('never-built')
  })

  it('reporting an outcome does NOT restart the poll — it is a fact about a press', async () => {
    const { result } = mount()
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalledTimes(1))

    await act(async () => {
      result.current.reportStartOutcome({ kind: 'not-painted' })
    })
    await settle()

    expect(api.fetchPreviewState).toHaveBeenCalledTimes(1)
  })
})
