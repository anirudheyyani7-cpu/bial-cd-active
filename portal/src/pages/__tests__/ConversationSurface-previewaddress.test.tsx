/**
 * CHARACTERIZATION — the preview address, exactly as it resolves today (Plan A, U1).
 *
 * WHAT THIS FILE IS FOR. The workspace-shell extraction moves the pane out of this page: the
 * three-source precedence becomes a named resolver called from above the chat (U2), and the iframe
 * becomes a shell-mounted host whose identity is that address plus its reload nonce (U4). Both
 * moves are claimed to be behaviour-preserving, and a suite that only exercised the happy path
 * would let a resolver that "tidied" the two predicates into one pass unnoticed. So this file pins
 * the address AS IT IS — including the asymmetry that looks like a bug and is not.
 *
 * THE THING BEING PINNED, in one line: a live turn's preview outranks a relaunched URL, which
 * outranks the session's URL — and the turn arm is gated by the CHAT predicate alone while the
 * lower two are gated by the PROJECT predicate alone.
 *
 * WHY THE LOWER ARM IS USUALLY THE RELAUNCHED URL HERE. A session whose status still frames is by
 * definition an ACTIVE build (`isActiveBuildStatus` counts `ready`), which closes the composer gate
 * on its own chat — so a scenario that needs both a lower arm and a send cannot use it. A relaunch
 * is the arm with no lifecycle at all (`useBuildSession.relaunch` deliberately leaves the session's
 * status untouched), so it frames without gating anything. The session arm has its own two
 * scenarios below, where nothing needs to be sent.
 *
 * WHAT IS DELIBERATELY NOT RE-PINNED HERE, because it is already pinned once and two assertions of
 * one fact drift apart:
 *  - the composer draft across a panel hide/show — `ConversationSurface-panel.test.jsx:57`;
 *  - the scroll position across the same cycle — `:86`, the one that actually discriminates a
 *    CSS-hide from an unmount;
 *  - a send refused while a turn runs — `ConversationSurface-composer.test.jsx:179`,
 *    `ConversationSurface-session.test.jsx:316,338`;
 *  - cross-project isolation of the build gate — `ConversationSurface-session.test.jsx:543`;
 *  - the reload nonce's two legitimate bumps, a turn ending over a live preview and the manual
 *    Reload — `components/__tests__/LivePreview.test.jsx:355` and `:375`.
 *
 * The pane is the REAL LivePreview, so the address is read off the actual iframe rather than off a
 * stubbed marker; a thin recording wrapper captures the props on the way through, because the
 * app-scoped ones (`compileState`, `workspaceLost`) are facts about the project's one app and their
 * whole characterization is that the chat predicate does NOT reach them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import {
  FakeEventSource, makeClient, primeClient, primeTurn, renderBuilderAt, withLiveBuildAnchor,
  statusResp, send, scriptBuildTurn, T_PREVIEW, T_BUILD_END, turnStreaming,
  T_DELTA, T_END, findStartAppControl, primeStandbyReattach,
} from './_builderSession.jsx'
import type { PreviewLifeState, PreviewState } from '../../utils/buildSessionApi'

/** The four arms, given URLs that cannot be confused with one another. */
const SESSION_URL = 'https://session-app.example.azurecontainerapps.io/'
const TURN_URL = 'https://turn-app.example.azurecontainerapps.io/'
const RELAUNCH_URL = 'https://relaunched-app.example.azurecontainerapps.io/'
/** The PROJECT arm's — the one a hard load arrives on, answered by the preview-state read. */
const PROJECT_URL = 'https://project-app.example.azurecontainerapps.io/'

const h = vi.hoisted(() => ({
  loadBuilds: vi.fn(), getBuild: vi.fn(),
  listProjectConversations: vi.fn(), buildUserParts: vi.fn(),
  startTurn: vi.fn(), readTurnStream: vi.fn(), buildFromPlan: vi.fn(), stopTurn: vi.fn(),
  resolvePlanOptions: vi.fn(),
  relaunchPreview: vi.fn(), stop: vi.fn(), getStatus: vi.fn(), forceEnd: vi.fn(),
  fetchPreviewState: vi.fn(), fetchSaveState: vi.fn(),
  // THE TWO PROBES THAT RIDE THE PREVIEW TICK, mocked only so they cannot reach a real `fetch`.
  // Neither was needed while every scenario here answered the read `unknown`: both are gated on a
  // LIVE container, and the project arm's scenarios below are the first in this file to produce
  // one. They never throw in production either (both swallow and answer a safe default), so
  // leaving them real would not have failed a test — it would have made every one of those
  // scenarios open a socket to nowhere and wait for it.
  fetchCompileState: vi.fn(), checkWorkspace: vi.fn(),
}))

/** Every prop bag the pane has been handed, in order. */
const paneProps: Record<string, unknown>[] = []

vi.mock('../../utils/builderHistory', () => ({
  loadBuilds: h.loadBuilds, getBuild: h.getBuild, deriveTitle: (t: string) => (t || '').slice(0, 40),
}))
vi.mock('../../utils/conversationApi', () => ({ listProjectConversations: h.listProjectConversations }))
vi.mock('../../components/layout/Navbar', () => ({ default: () => null }))
// A RECORDING WRAPPER, not a stub: the real pane still renders (so the iframe and its element
// identity are observable) and the props are captured on the way through (so the app-scoped ones
// are readable without asserting against the pane's cover copy, which is not this file's subject).
vi.mock('../../components/LivePreview', async (orig) => {
  const actual = await orig<typeof import('../../components/LivePreview')>()
  return {
    ...actual,
    default: (props: Record<string, unknown>) => {
      paneProps.push(props)
      return createElement(actual.default, props)
    },
  }
})
vi.mock('../../utils/attachmentStore', async (orig) => ({
  ...(await orig<typeof import('../../utils/attachmentStore')>()),
  buildUserParts: h.buildUserParts,
}))
// `switchMode` is GONE — a chat's kind is fixed at creation, so there is no per-thread
// setting left to switch, and a factory that still listed it would be mocking an export the
// real module no longer has. This file was the last of ten still carrying the key; the other
// nine already said so here. `resolvePlanOptions` is a real export, kept mocked only because
// the surface reaches for it when a plan offer is answered — never exercised here.
vi.mock('../../utils/turnStreamApi', async (orig) => ({
  ...(await orig<typeof import('../../utils/turnStreamApi')>()),
  startTurn: (...a: unknown[]) => h.startTurn(...a),
  readTurnStream: (...a: unknown[]) => h.readTurnStream(...a),
  buildFromPlan: (...a: unknown[]) => h.buildFromPlan(...a),
  resolvePlanOptions: (...a: unknown[]) => h.resolvePlanOptions(...a),
  stopTurn: (...a: unknown[]) => h.stopTurn(...a),
}))
vi.mock('../../utils/buildSessionApi', async (orig) => ({
  ...(await orig<typeof import('../../utils/buildSessionApi')>()),
  fetchPreviewState: (...a: unknown[]) => h.fetchPreviewState(...a),
  fetchSaveState: (...a: unknown[]) => h.fetchSaveState(...a),
  fetchCompileState: (...a: unknown[]) => h.fetchCompileState(...a),
  checkWorkspace: (...a: unknown[]) => h.checkWorkspace(...a),
  // `StartAppControl.tsx` imports `relaunchPreview` DIRECTLY from this module rather than through
  // the injected C3 client — it predates the client and was never moved onto it (Plan F, U3). This
  // suite's vehicle for a relaunched URL is that control now (`RelaunchAffordance` is gone), so its
  // call has to land on the same `h.relaunchPreview` the fixtures below already prime.
  relaunchPreview: (...a: unknown[]) => h.relaunchPreview(...a),
}))

const deps = () => {
  const fake = new FakeEventSource('x')
  return { client: makeClient(h), eventSourceFactory: () => fake }
}

const frame = () => document.querySelector('iframe')
const framedUrl = () => frame()?.getAttribute('src') ?? null
/** The newest value the pane was handed for `name` — the app-scoped props read this. */
const lastPaneProp = (name: string) => paneProps[paneProps.length - 1]?.[name]

beforeEach(() => {
  vi.clearAllMocks()
  paneProps.length = 0
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  primeClient(h)
  primeTurn(h)
  h.getBuild.mockResolvedValue(null)
  h.loadBuilds.mockResolvedValue([])
  h.listProjectConversations.mockResolvedValue([])
  h.buildUserParts.mockImplementation(async (t: string) => [{ type: 'text', text: t }])
  h.relaunchPreview.mockResolvedValue({
    appId: 'a1', previewUrl: RELAUNCH_URL, status: 'ready', restoredFromFailedBuild: false,
  })
  // Neither probe is this file's subject; both are answered so nothing reaches a real `fetch`.
  h.fetchPreviewState.mockResolvedValue({
    state: 'unknown', alive: false, previewUrl: null, occupyingProjectName: null, restorable: null,
  })
  h.fetchSaveState.mockResolvedValue({ dirty: null })
  h.fetchCompileState.mockResolvedValue('unknown')
  h.checkWorkspace.mockResolvedValue(false)
})
afterEach(() => cleanup())

/**
 * Bring up a page whose RELAUNCH arm is live and stamped to `projectId`.
 *
 * RE-POINTED (Plan F, U3/U4). The old vehicle clicked a "Relaunch" button `LivePreview` rendered
 * inside its own terminal placeholder, fed by `handleRelaunch` — which stamped `sessionProjectRef`
 * as a side effect of the click itself. All of it is gone now: `RelaunchAffordance` and its four
 * render sites went first, `handleRelaunch` had no caller after that because `onRelaunch` was a
 * pane prop nothing read, and the whole chain — callback, flag, error and hook function — has since
 * been deleted rather than left threaded for typing continuity. The one control left
 * is `StartAppControl`, and getting it a chance to press is the whole of what changed here —
 * `primeStandbyReattach` stamps the ref `StartAppControl`'s OWN click path never touches, and
 * `findStartAppControl` presses whichever label the map is currently showing (both call the exact
 * same underlying `start()`). See its docblock in `_builderSession.jsx` for the full account,
 * including the real product bug this chase turned up.
 */
async function relaunchFramedAt(chatId: string, projectId: string) {
  const reattach = primeStandbyReattach(h, { chatId, projectId })
  const view = renderBuilderAt({ chatId, projectId, hasSavedBuild: true, deps: deps() })
  await waitFor(() => expect(h.getStatus).toHaveBeenCalled())
  fireEvent.click(await findStartAppControl())
  await waitFor(() => expect(h.relaunchPreview).toHaveBeenCalled())
  await waitFor(() => expect(framedUrl()).toBe(RELAUNCH_URL))
  // Settle the standby reattach now that the relaunch has framed what this fixture needs: several
  // callers send a turn right after this returns, and a reattach left pending forever would keep
  // the composer gate shut on them for good (see the docblock on `primeStandbyReattach`).
  reattach.settle()
  await waitFor(() => expect(screen.queryByText(/checking whether a build/i)).toBeNull())
  return view
}

/** A turn that streams one preview frame and completes — the chat-scoped arm, on demand. */
const turnFraming = (url: string) =>
  turnStreaming([T_DELTA('working on it'), T_PREVIEW(url), T_END()])

describe('BuilderPage — the preview address: three sources, two predicates', () => {
  it('a live turn preview outranks a relaunched URL when BOTH predicates hold', async () => {
    const view = await relaunchFramedAt('chat-A', 'pA')

    h.readTurnStream.mockImplementation(turnFraming(TURN_URL))
    await send('add a chart')

    await waitFor(() => expect(framedUrl()).toBe(TURN_URL))
    view.unmount()
  })

  it('a turn narrating a SIBLING chat of the same project does not frame — the relaunched URL does', async () => {
    // The chat predicate, violated on its own. The turn's URL is still in state; it is simply not
    // this chat's turn, and a resolver that dropped `turnNarrativeIsThisChat` would frame a
    // sibling conversation's app over this one.
    const view = await relaunchFramedAt('chat-A', 'pA')
    h.readTurnStream.mockImplementation(turnFraming(TURN_URL))
    await send('add a chart')
    await waitFor(() => expect(framedUrl()).toBe(TURN_URL))

    view.moveTo({ chatId: 'chat-B' }) // same project, sibling conversation

    await waitFor(() => expect(framedUrl()).toBe(RELAUNCH_URL))
    view.unmount()
  })

  it('with the project predicate false and no live turn, the pane frames NOTHING', async () => {
    // Both lower arms are gated by the project predicate, so the address resolves to null. Never a
    // fallback, and above all never the other project's app.
    const view = await relaunchFramedAt('chat-A', 'pA')

    view.moveTo({ chatId: 'chat-B', projectId: 'pB' })

    await waitFor(() => expect(frame()).toBeNull())
    view.unmount()
  })

  it('THE ASYMMETRY: the project predicate is false and the turn still frames', async () => {
    // The cell a resolver that "tidied" the two predicates into one would get wrong. The turn arm
    // is chat-scoped ONLY — an ordinary send stamps the turn narrative and never the session's
    // project — so a turn narrating the open chat frames even from a project the lower arms are
    // out of scope for.
    const view = await relaunchFramedAt('chat-A', 'pA')

    view.moveTo({ chatId: 'chat-B', projectId: 'pB' })
    await waitFor(() => expect(frame()).toBeNull()) // the lower arms are gated off, as above

    h.readTurnStream.mockImplementation(turnFraming(TURN_URL))
    await send('build me something here')

    await waitFor(() => expect(framedUrl()).toBe(TURN_URL))
    view.unmount()
  })

  it('a relaunched URL outranks the session\'s own URL', async () => {
    // The middle of the precedence, which only shows when both lower arms are populated at once: a
    // relaunch restores an app the ENDED session's dead preview would otherwise still be naming.
    //
    // RE-POINTED. The session's own dead `SESSION_URL` is exactly what used to make `LivePreview`
    // render its terminal placeholder WITH a Relaunch button — that button is gone, and framing a
    // real (if dead) session URL is enough on its own to keep `AppPane` showing `AppPaneHost`'s own
    // now-buttonless terminal card (`showTerminal`), never `NoFrame`. What gets `StartAppControl`
    // a chance to press here is the SAME veto `AppPane.tsx` documents for every other state that
    // definitely means nothing is serving: a settled `asleep`+`restorable` reading resolves the
    // workspace map to `not-running`, and THAT swaps `AppPaneHost` for `NoFrame`. The poll only
    // ever runs once something is framed, and the dead session URL is what starts it — so the
    // sequence is mount, let the poll answer, THEN find and press the one control it leaves behind.
    h.getBuild.mockResolvedValue(withLiveBuildAnchor('live-7'))
    h.getStatus.mockResolvedValue(
      statusResp({ sessionId: 'live-7', status: 'ended', previewUrl: SESSION_URL }),
    )
    h.fetchPreviewState.mockResolvedValue({
      state: 'asleep', alive: false, previewUrl: null, occupyingProjectName: null, restorable: true,
    })
    const view = renderBuilderAt({ chatId: 'chat-A', projectId: 'pA', hasSavedBuild: true, deps: deps() })
    await waitFor(() => expect(h.getStatus).toHaveBeenCalledWith('live-7'))

    fireEvent.click(await findStartAppControl())
    await waitFor(() => expect(h.relaunchPreview).toHaveBeenCalled())
    // The veto that got `StartAppControl` on screen at all is still standing — `fetchPreviewState`
    // is still answering the same `asleep`/`restorable` reading, and the press does not itself
    // change what the workspace map says (`onStartOutcome` only asks it again; the resolved
    // ADDRESS and what `AppPane` is willing to FRAME from it are two different questions — see its
    // own veto note). Answer it `alive` now, the same way the poll suite re-arms one, so the frame
    // this precedence claim is actually about gets a chance to mount.
    h.fetchPreviewState.mockResolvedValue({
      state: 'alive', alive: true, previewUrl: RELAUNCH_URL, occupyingProjectName: null, restorable: null,
    })
    fireEvent.focus(window)

    await waitFor(() => expect(framedUrl()).toBe(RELAUNCH_URL))
    view.unmount()
  })

  it('the session\'s URL frames on its own, and only for the project it belongs to', async () => {
    // The bottom arm, and the project predicate that gates it. Nothing is sent here — a session
    // still framing is an ACTIVE build, which closes this chat's composer by design.
    h.getBuild.mockResolvedValue(withLiveBuildAnchor('live-7'))
    h.getStatus.mockResolvedValue(
      statusResp({ sessionId: 'live-7', status: 'ready', previewUrl: SESSION_URL }),
    )
    const view = renderBuilderAt({ chatId: 'chat-A', projectId: 'pA', deps: deps() })
    await waitFor(() => expect(framedUrl()).toBe(SESSION_URL))

    // The SAME session, viewed from another project: out of scope, so it reaches nothing.
    h.getBuild.mockResolvedValue(null)
    view.moveTo({ chatId: 'chat-B', projectId: 'pB' })

    await waitFor(() => expect(frame()).toBeNull())
    view.unmount()
  })
})

describe('BuilderPage — the app-scoped props are NOT narrowed to the open chat', () => {
  it('the compile state reaches the pane while the narrating chat is a sibling', async () => {
    // `compileState` and `workspaceLost` are facts about the PROJECT'S ONE APP, and their producer
    // outlives the turn. They are deliberately ungated by `turnNarrativeIsThisChat`, and blanking
    // them on a chat switch is what leaves an error screen uncovered. They are not address sources
    // and must not follow the address into the resolver.
    const view = await relaunchFramedAt('chat-A', 'pA')
    h.readTurnStream.mockImplementation(
      turnStreaming([T_DELTA('working'), T_PREVIEW(TURN_URL), { type: 'compile', seq: 4, state: 'failed' }, T_END()]),
    )
    await send('add a chart')
    await waitFor(() => expect(lastPaneProp('compileState')).toBe('failed'))

    view.moveTo({ chatId: 'chat-B' }) // sibling chat — the chat predicate is now false

    // The address followed the predicate (the turn's URL is gone); the compile fact did not.
    await waitFor(() => expect(framedUrl()).toBe(RELAUNCH_URL))
    expect(lastPaneProp('compileState')).toBe('failed')
    view.unmount()
  })
})

describe('BuilderPage — the frame\'s identity is its ADDRESS, and nothing else', () => {
  it('re-rendering at the same address keeps the SAME iframe node and does not re-issue its src', async () => {
    // AE4's mechanism, at the page level. `LivePreview` pins that a same-key render keeps the node
    // (`LivePreview.test.jsx:143`); what is unproven without this is that the PAGE keeps handing it
    // the same address across an ordinary re-render — the property the shell extraction must not
    // lose, since after it the pane outlives the route entirely.
    const view = await relaunchFramedAt('chat-A', 'pA')
    const before = frame()
    let loads = 0
    before?.addEventListener('load', () => { loads += 1 })

    view.rerenderSame()

    expect(frame()).toBe(before)
    expect(framedUrl()).toBe(RELAUNCH_URL)
    expect(loads).toBe(0)
    view.unmount()
  })

  it('a turn ending on the SAME url does not re-frame', async () => {
    // Half of the failure this pins. Re-deriving the frame's key from anything but the address —
    // the route, a render counter, the turn's terminal — reloads a live app for no reason and
    // takes its HMR socket with it. The other half is the scenario below.
    const view = await relaunchFramedAt('chat-A', 'pA')

    // `hold` — the send IS the build here, so its socket has to stay open for the frames
    // pushed in below rather than replaying a plan and completing.
    const turn = scriptBuildTurn({ hold: true })
    h.readTurnStream.mockImplementation(turn.impl)
    // AN ORDINARY SEND, not the plan card. This page renders a BUILD chat and every send on one
    // is a build turn, so a send is the shortest honest way to get a build streaming here — and
    // the card is no longer even a route to one from this chat: pressing Build it hands off to a
    // SECOND chat and navigates there, so the turn it starts would never stream into this frame.
    await send('a visitor app')
    // NO `turnId` IN THE SUBSCRIBE, and that is the send path's shape rather than an oversight:
    // a send subscribes to whatever turn its own POST just started on this conversation, so the
    // id is the server's to know. Only a RE-ATTACH names a turn, because it is joining one it
    // did not start.
    await waitFor(() =>
      expect(h.readTurnStream).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'chat-A' }),
      ),
    )
    await turn.frame(T_PREVIEW(TURN_URL))
    await waitFor(() => expect(framedUrl()).toBe(TURN_URL))
    const framedByTheTurn = frame()

    await turn.frame(T_BUILD_END({ previewUrl: TURN_URL }))
    await turn.end()

    expect(frame()).toBe(framedByTheTurn)
    expect(framedUrl()).toBe(TURN_URL)
    view.unmount()
  })

  it('a different project is a different app, so a different address, so a genuine remount', async () => {
    // The other half. Implementing "never unmount" by pinning the key to a constant satisfies the
    // scenario above and leaves a frame pointing at a container that no longer exists, with nothing
    // able to detect it.
    const view = await relaunchFramedAt('chat-A', 'pA')
    const before = frame()

    view.moveTo({ chatId: 'chat-B', projectId: 'pB' })
    await waitFor(() => expect(frame()).toBeNull())

    // Coming back re-acquires the address, and the frame that returns is a NEW element.
    view.moveTo({ chatId: 'chat-A', projectId: 'pA' })
    await waitFor(() => expect(framedUrl()).toBe(RELAUNCH_URL))
    expect(frame()).not.toBe(before)
    view.unmount()
  })
})

/**
 * THE FOURTH ARM: the project's own live preview, on a CHAT route (#192, U11).
 *
 * WHAT WAS BROKEN. Reload a build chat whose app is up — a bookmark, an F5, a browser restart —
 * and the headline said the app was running while the pane framed nothing. Two independent
 * reasons, and fixing either alone changes nothing on screen:
 *
 *  1. this surface fed the resolver `projectPreviewUrl: null`, so the read it was already making
 *     could not reach the address at all;
 *  2. every project-scoped arm is gated by `sessionBelongsToOpenProject`, which this route supplies
 *     as `sessionProjectMatches` — a ref stamped only by a reattach or by the start control. A hard
 *     load has done neither, so it is `false` and the arm is closed whatever it is fed.
 *
 * The scenarios below pin the pair, and the LOOP GUARD pins the third part: with the address now
 * downstream of the poll's own answer, keeping the framed URL in the poll effect's dependency list
 * makes the effect tear itself down on every successful read — its first statement is
 * `setPolledPreview(null)` — for an unbounded stream of requests and a flapping iframe `src`. The
 * count is asserted, not "settled": a self-re-arming effect settles too, one request at a time,
 * forever.
 */
describe('BuilderPage — the project arm, and the hard load it exists for', () => {
  /** A whole preview-state body, in the shape `fetchPreviewState` parses one into. */
  const polled = (state: PreviewLifeState, restorable: boolean | null = null): PreviewState => ({
    state,
    alive: state === 'alive',
    previewUrl: state === 'alive' ? PROJECT_URL : null,
    occupyingProjectName: null,
    occupyingProjectId: null,
    restorable,
  })
  const probeCount = () => h.fetchPreviewState.mock.calls.length
  /** One task turn, inside act — no clock is moved, so nothing here is a poll TICK. A macrotask
   *  rather than a microtask, so a deferred probe answer (the loop guard's) actually lands. */
  const flush = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })

  it('a hard load with no session frames the app the poll says is running', async () => {
    // The whole bug, in one scenario: no anchor, no session, no press — just the route and the
    // read it already makes. Before the fix this rendered the running-app copy over an empty pane.
    h.fetchPreviewState.mockResolvedValue(polled('alive'))

    const view = renderBuilderAt({ chatId: 'chat-A', projectId: 'pA', deps: deps() })

    await waitFor(() => expect(framedUrl()).toBe(PROJECT_URL))
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
    view.unmount()
  })

  it('THE LOOP GUARD: a successful read does not re-arm the effect that made it', async () => {
    // Parts 1 and 2 are individually harmless and JOINTLY are the bug: once the address is a
    // function of the probe's own answer, an effect that also depends on the address tears itself
    // down on every successful read — its first statement is `setPolledPreview(null)` — for an
    // unbounded stream of requests and a flapping iframe `src`.
    //
    // ★ THE ANSWER MUST ARRIVE ON A LATER TASK, AND THAT IS THE WHOLE TEST. With
    // `mockResolvedValue` the mutant is INERT: the answer lands in the same flush as the effect's
    // own `setPolledPreview(null)`, React coalesces the two into one commit, the dependency never
    // observes the flicker and the loop never starts — verified, the reverted fix passed at
    // exactly two reads. A real network answers a task later, so the `null` commit lands FIRST and
    // the effect re-runs on it. One `setTimeout` is the difference between this guard and a green
    // test that proves nothing.
    h.fetchPreviewState.mockImplementation(
      () => new Promise<PreviewState>((resolve) => { setTimeout(() => resolve(polled('alive')), 0) }),
    )
    const view = renderBuilderAt({ chatId: 'chat-A', projectId: 'pA', deps: deps() })
    await waitFor(() => expect(framedUrl()).toBe(PROJECT_URL))

    // ONE read got us here — the mount's. Asserted as a number rather than as "it stopped",
    // because a self-re-arming effect stops too, between one request and the next, forever.
    const settled = probeCount()
    expect(settled).toBe(1)

    // Twelve renders at the same identity, each given a full task turn to fire anything it armed.
    for (let i = 0; i < 12; i += 1) {
      view.rerenderSame()
      await flush()
    }

    expect(probeCount()).toBe(settled)
    expect(framedUrl()).toBe(PROJECT_URL) // and the src never flapped
    view.unmount()
  })

  it('an SPA move to a sibling chat keeps the SAME frame — the app does not reload', async () => {
    // The path that works today, and the one this unit must not regress. The project arm is a fact
    // about the project, so a move between its conversations is not an invalidation: the address is
    // byte-identical, the iframe node is the same node, and the app inside it never reloads.
    h.fetchPreviewState.mockResolvedValue(polled('alive'))
    const view = renderBuilderAt({ chatId: 'chat-A', projectId: 'pA', deps: deps() })
    await waitFor(() => expect(framedUrl()).toBe(PROJECT_URL))
    const before = frame()

    view.moveTo({ chatId: 'chat-B' }) // same project, sibling conversation

    await waitFor(() => expect(framedUrl()).toBe(PROJECT_URL))
    expect(frame()).toBe(before)
    view.unmount()
  })

  it('a live turn\'s preview still outranks the project address', async () => {
    // The precedence is unchanged: the new arm is ranked LAST, so it can never displace the turn
    // the citizen is watching. (This is also the scenario that exercises the fold — the turn's
    // `preview` frame is one of the two lifecycle signals now folded into the probe epoch.)
    h.fetchPreviewState.mockResolvedValue(polled('alive'))
    const view = renderBuilderAt({ chatId: 'chat-A', projectId: 'pA', deps: deps() })
    await waitFor(() => expect(framedUrl()).toBe(PROJECT_URL))

    h.readTurnStream.mockImplementation(turnFraming(TURN_URL))
    await send('add a chart')

    await waitFor(() => expect(framedUrl()).toBe(TURN_URL))
    view.unmount()
  })

  it('a `slot_taken` answer frames NOTHING, and the held arm renders instead', async () => {
    // The arm's contract is `alive` and nothing else. Another project is holding the one slot, so
    // there is no framable URL — and the pane says so rather than framing a guess.
    h.fetchPreviewState.mockResolvedValue(polled('slot_taken', true))

    const view = renderBuilderAt({ chatId: 'chat-A', projectId: 'pA', deps: deps() })

    await waitFor(() => expect(screen.queryByTestId('app-pane-empty')).not.toBeNull())
    expect(screen.getByTestId('app-pane-empty').getAttribute('data-workspace-state'))
      .toBe('held-unattributed')
    expect(frame()).toBeNull()
    view.unmount()
  })

  it('a move to another project never frames the project it just left, not for one commit', async () => {
    // WHAT THE STAMP MADE POSSIBLE, AND WHAT THE LABEL TAKES BACK. One instance of this component
    // survives a project switch, and the poll's answer is state — the effect that drops it runs
    // AFTER the commit. So the first render at the new project holds the previous project's live
    // URL while the stamp above already points at the project now on screen: one commit of
    // somebody else's app in this pane. `paneProps` records every bag the pane was handed, so the
    // window is visible here even though it closes before any `waitFor` could look.
    h.fetchPreviewState.mockImplementation(async (id: string) =>
      id === 'pA' ? polled('alive') : polled('asleep', true),
    )
    const view = renderBuilderAt({ chatId: 'chat-A', projectId: 'pA', deps: deps() })
    await waitFor(() => expect(framedUrl()).toBe(PROJECT_URL))
    const seen = paneProps.length

    view.moveTo({ chatId: 'chat-B', projectId: 'pB' })

    await waitFor(() => expect(frame()).toBeNull())
    expect(paneProps.slice(seen).map((props) => props.previewUrl)).not.toContain(PROJECT_URL)
    view.unmount()
  })
})
