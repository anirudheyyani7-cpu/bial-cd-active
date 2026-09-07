/**
 * WHY THIS EXISTS — pins the preview address exactly as it resolves today, ahead of the
 * workspace-shell extraction that turns this three-source precedence into a named resolver
 * called from above the chat. A resolver that "tidied" the two gating predicates into one must
 * not pass unnoticed, so this pins the asymmetry below that looks like a bug and is not.
 *
 * THE RULE: a live turn's preview outranks a relaunched URL, which outranks the session's URL —
 * the turn arm is gated by the CHAT predicate alone, the lower two by the PROJECT predicate alone.
 *
 * Why the lower arm below is usually the relaunched URL: a session still framing is by definition
 * an ACTIVE build, which closes this chat's own composer gate — so a scenario needing both a
 * lower arm and a send can't use it. A relaunch has no lifecycle at all, so it frames without
 * gating anything.
 *
 * NOT RE-PINNED HERE (already pinned once, elsewhere):
 *  - composer draft + scroll across a hide/show cycle → `ProjectWorkspace.test.tsx`
 *  - a send refused mid-turn → `ConversationSurface-composer.test.jsx`, `-session.test.jsx`
 *  - cross-project build-gate isolation → `ConversationSurface-session.test.jsx`
 *  - the reload nonce's two legitimate bumps → `components/__tests__/LivePreview.test.jsx`
 *
 * The pane is the REAL LivePreview; a recording wrapper captures its props on the way through,
 * since the app-scoped ones (`compileState`, `workspaceLost`) are how this file proves the chat
 * predicate does NOT reach them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import {
  FakeEventSource, makeClient, primeClient, primeTurn, renderBuilderAt, withLiveBuildAnchor,
  statusResp, send, scriptBuildTurn, T_PREVIEW, T_BUILD_END, turnStreaming,
  T_DELTA, T_END, findStartAppControl, primeStandbyReattach,
} from './_builderSession.jsx'

/** The three arms, given URLs that cannot be confused with one another. */
const SESSION_URL = 'https://session-app.example.azurecontainerapps.io/'
const TURN_URL = 'https://turn-app.example.azurecontainerapps.io/'
const RELAUNCH_URL = 'https://relaunched-app.example.azurecontainerapps.io/'

const h = vi.hoisted(() => ({
  loadBuilds: vi.fn(), getBuild: vi.fn(),
  listProjectConversations: vi.fn(), buildUserParts: vi.fn(),
  startTurn: vi.fn(), readTurnStream: vi.fn(), buildFromPlan: vi.fn(), stopTurn: vi.fn(),
  resolvePlanOptions: vi.fn(),
  relaunchPreview: vi.fn(), stop: vi.fn(), getStatus: vi.fn(), forceEnd: vi.fn(),
  fetchPreviewState: vi.fn(), fetchSaveState: vi.fn(),
}))

/** Every prop bag the pane has been handed, in order. */
const paneProps: Record<string, unknown>[] = []

vi.mock('../../utils/builderHistory', () => ({
  loadBuilds: h.loadBuilds, getBuild: h.getBuild, deriveTitle: (t: string) => (t || '').slice(0, 40),
}))
vi.mock('../../utils/conversationApi', () => ({ listProjectConversations: h.listProjectConversations }))
vi.mock('../../components/layout/Navbar', () => ({ default: () => null }))
// A recording wrapper, not a stub — see the module docblock for why.
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
// `switchMode` is GONE — a chat's kind is fixed at creation. `resolvePlanOptions` stays mocked
// because the surface reaches for it when a plan offer is answered, even though it's never
// exercised here.
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
  // `StartAppControl.tsx` imports `relaunchPreview` DIRECTLY from this module rather than through
  // the injected client, so its call has to land on the same `h.relaunchPreview` the fixtures
  // below already prime.
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
})
afterEach(() => cleanup())

/**
 * Brings up a page whose RELAUNCH arm is live, stamped to `projectId`.
 *
 * The vehicle is `StartAppControl` (the old Relaunch-button affordance is gone):
 * `primeStandbyReattach` stamps the ref its own click path never touches, and
 * `findStartAppControl` presses whichever label it's currently showing. Full account,
 * including a real product bug this uncovered, is in `_builderSession.jsx`'s docblock.
 */
async function relaunchFramedAt(chatId: string, projectId: string) {
  const reattach = primeStandbyReattach(h, { chatId, projectId })
  const view = renderBuilderAt({ chatId, projectId, hasSavedBuild: true, deps: deps() })
  await waitFor(() => expect(h.getStatus).toHaveBeenCalled())
  fireEvent.click(await findStartAppControl())
  await waitFor(() => expect(h.relaunchPreview).toHaveBeenCalled())
  await waitFor(() => expect(framedUrl()).toBe(RELAUNCH_URL))
  // Several callers send a turn right after this returns — a reattach left pending would keep
  // the composer gate shut on them for good (see `primeStandbyReattach`'s docblock).
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
    // `asleep`+`restorable` is what resolves the workspace map to `not-running` for that dead
    // session. The poll only runs once something is framed, so the sequence here is mount, let the
    // poll answer, THEN press.
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
    // The press doesn't itself change what the workspace map says — `onStartOutcome` only asks it
    // again. Answer `alive` now so the frame this test is actually about gets a chance to mount.
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
    // `compileState`/`workspaceLost` are facts about the PROJECT'S ONE APP, deliberately ungated
    // by `turnNarrativeIsThisChat` — blanking them on a chat switch is what leaves an error screen
    // uncovered.
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
    // `LivePreview.test.jsx` already pins that a same-key render keeps the node; unproven without
    // this is that the PAGE keeps handing it the same address across an ordinary re-render.
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
    // An ordinary send, not the plan card: this page renders a BUILD chat, so every send on it is
    // already a build turn — the card would hand off to a SECOND chat whose turn would never
    // stream into this frame.
    await send('a visitor app')
    // NO `turnId` in the subscribe is the send path's shape, not an oversight: a send subscribes
    // to whatever turn its own POST just started, so the id is the server's to know. Only a
    // RE-ATTACH names a turn, because it's joining one it didn't start.
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

    view.moveTo({ chatId: 'chat-A', projectId: 'pA' })
    await waitFor(() => expect(framedUrl()).toBe(RELAUNCH_URL))
    expect(frame()).not.toBe(before)
    view.unmount()
  })
})
