/**
 * The build outcome, portal side.
 *
 * The durable record is the server's — builds run for minutes and users close tabs. This page
 * renders the same outcome locally, off the `turn_ended` frame (`status`, `reason`, tri-state
 * `snapshotCommitted`), and writes nothing itself.
 *
 * A build IS its turn, so `turnId` is the identity a record is keyed by, and the test with teeth
 * here is that DEDUPE: after a reload the transcript already holds the server's row, and a
 * replayed terminal would stack a second copy on top of it. Both turn watchers on this page,
 * `fireRelayTurn` and `reattachToTurn`, call `showBuildOutcome` once their stream settles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { FakeEventSource, makeClient, primeClient, waitForGateOpen, PREVIEW_URL, T_STEP, T_WORKSPACE, T_PREVIEW, T_BUILD_END } from './_builderSession.jsx'

const h = vi.hoisted(() => ({
  loadBuilds: vi.fn(), getBuild: vi.fn(),
  listProjectConversations: vi.fn(), buildUserParts: vi.fn(),
  startTurn: vi.fn(), readTurnStream: vi.fn(), buildFromPlan: vi.fn(), stopTurn: vi.fn(),
  resolvePlanOptions: vi.fn(),
  relaunchPreview: vi.fn(), stop: vi.fn(), getStatus: vi.fn(), forceEnd: vi.fn(),
}))

vi.mock('../../utils/builderHistory', () => ({
  loadBuilds: h.loadBuilds, getBuild: h.getBuild, deriveTitle: (t) => (t || '').slice(0, 40),
}))
vi.mock('../../utils/conversationApi', () => ({ listProjectConversations: h.listProjectConversations }))
vi.mock('../../components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../components/LivePreview', () => ({ default: () => null }))
vi.mock('../../components/AttachmentChips', () => ({ default: () => null }))
vi.mock('../../utils/attachmentStore', async (orig) => ({ ...(await orig()), buildUserParts: h.buildUserParts }))
// `switchMode` is GONE — a chat's kind is fixed at creation, so there is no per-thread setting
// left to switch. `resolvePlanOptions` is a real export, kept mocked only because
// the surface reaches for it when a plan offer is answered — never exercised here, since this
// suite never renders an offer.
vi.mock('../../utils/turnStreamApi', async (orig) => ({
  ...(await orig()),
  startTurn: (...a) => h.startTurn(...a),
  readTurnStream: (...a) => h.readTurnStream(...a),
  buildFromPlan: (...a) => h.buildFromPlan(...a),
  // A build's Stop is the TURN stop now — there is no session-level stop left to reach for.
  stopTurn: (...a) => h.stopTurn(...a),
  resolvePlanOptions: (...a) => h.resolvePlanOptions(...a),
}))

import ConversationSurface from '../../components/chat/ConversationSurface'

function renderThread(chatId = 'thread-1') {
  const fake = new FakeEventSource(chatId)
  const deps = { client: makeClient(h), eventSourceFactory: () => fake }
  const view = render(
    <MemoryRouter initialEntries={[`/chat/${chatId}`]}>
      <Routes>
        <Route path="/chat/:chatId" element={<ConversationSurface projectId="p1" buildSessionDeps={deps} />} />
      </Routes>
    </MemoryRouter>,
  )
  return { ...view, fake }
}

const composer = () => screen.getByPlaceholderText(/ask for another change/i)
async function send(text) {
  await waitForGateOpen()
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.keyDown(composer(), { key: 'Enter' })
}

/** The consolidating snapshot every subscribe gets FIRST (`backend/.../turns.py` owns that rule),
 *  carrying the `turnId` this page reads into `liveTurnIdRef` AND `sink.turnId` — the fact the
 *  Stop test below depends on (Stop needs `liveTurnIdRef` populated WHILE the turn is still
 *  running, not only at its terminal). */
const T_SNAPSHOT = (turnId, seq = 1) => ({
  type: 'snapshot', seq, turnId, turnStatus: 'running', items: [], parts: [], working: false,
})

/**
 * Script an ordinary send's own turn stream as an OPEN socket a test can push frames into by
 * hand. Not `_builderSession.jsx`'s `scriptBuildTurn`, which branches on whether `readTurnStream`
 * was called WITH a `turnId`: `fireRelayTurn` never passes one, and never asks the chat's kind
 * either — every send on this page opens the one plain subscription, and that IS the build.
 */
function scriptTurn(turnId, opening) {
  const live = { emit: null, close: null }
  const frames = opening ?? [T_SNAPSHOT(turnId), T_WORKSPACE(undefined, 2)]
  const impl = async ({ onFrame }) => {
    live.emit = onFrame
    for (const frame of frames) onFrame(frame)
    return new Promise((resolve) => { live.close = resolve })
  }
  return {
    impl,
    /** Push more frames into the open turn (wrapped in act, so effects flush between). */
    frame: async (...more) => {
      await act(async () => { for (const frame of more) live.emit?.(frame) })
    },
    /** Close the socket. The TRANSPORT outcome only; the frames decide the semantic one. */
    end: async (outcome = 'completed') => {
      await act(async () => { live.close?.(outcome); await Promise.resolve() })
    },
  }
}

/**
 * Drive a build to running: an ordinary send opens the write turn directly — no plan text, no
 * card, no `Build it` press. `readTurnStream` having been called is what "the build is
 * underway" means now, and it is the socket every frame below is pushed into.
 */
async function runBuild(turn, text = 'a visitor app') {
  await send(text)
  await waitFor(() => expect(h.readTurnStream).toHaveBeenCalled())
  await turn.frame(T_STEP('Scaffolding your app…'))
}

/**
 * THE OUTCOME AS A CITIZEN READS IT NOW — prose in the transcript, not a card.
 *
 * The summary sentence is the message's own TEXT (`outcomeSummary` on the surface,
 * `outcome.py::_summary` on the server — the two are written to match so a live render and a
 * reloaded row read identically), so the queries below match the SENTENCE rather than a test id:
 * the test id proved a box existed, this proves the citizen was told.
 */
const OUTCOME_SENTENCE = /build finished\.|the build failed|the build stopped/i
const outcomeCards = () =>
  screen
    .queryAllByTestId('assistant-message')
    .filter((m) => OUTCOME_SENTENCE.test(m.textContent || ''))
const findOutcome = async () => {
  await waitFor(() => expect(outcomeCards().length).toBeGreaterThan(0))
  return outcomeCards()[outcomeCards().length - 1]
}

/**
 * Everything the page actually PUT ON THE WIRE — one JSON string per send. The send path makes
 * exactly one server call, `startTurn`, and narrows the composer's parts through
 * `wireMessageFromParts` into `{text, attachmentTexts, attachmentIds}`, so a build part cannot
 * ride it by construction. Asserting on the serialized payload keeps the claim honest against
 * both ways it could stop being true: a parts-carrying body coming back, or an outcome sentence
 * written into `text`.
 */
const wireSends = () => h.startTurn.mock.calls.map((call) => JSON.stringify(call))

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  primeClient(h)
  h.getBuild.mockResolvedValue(null)
  h.loadBuilds.mockResolvedValue([])
  h.listProjectConversations.mockResolvedValue([])
  h.buildUserParts.mockImplementation(async (text) => [{ type: 'text', text }])
  h.startTurn.mockResolvedValue({ turnId: 't1' })
  h.stopTurn.mockResolvedValue('stopping')
})
afterEach(cleanup)

describe('showing the outcome', () => {
  it('does NOT present a dead preview link on the ended-build card (F4)', async () => {
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    await turn.frame(T_PREVIEW()) // the url the record will carry
    await turn.frame(T_BUILD_END({ turnId: 't1' }))
    await turn.end()

    const card = await findOutcome()
    expect(card.textContent).toMatch(/build finished/i)
    // The per-build preview URL died with its sandbox the moment the build ended, so the record —
    // permanent, and read again on every future open — must never surface it as a working link.
    // The live "Relaunch preview" affordance lives in the preview pane. The card that used
    // to render this link conditionally is gone, so the guarantee is now structural: no link is
    // rendered because no renderer exists to render one.
    expect(card.querySelector(`a[href="${PREVIEW_URL}"]`)).toBeNull()
  })

  it('never writes the outcome itself — that is the server’s job', async () => {
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    await turn.frame(T_PREVIEW(), T_BUILD_END({ turnId: 't1' }))
    await turn.end()
    await findOutcome()

    // Two writers would mean two records for one build (the server's row and this one), and the
    // server's is the one that survives a closed tab.
    //
    // LIVENESS FIRST, because this is an assert-absence test: zero sends would satisfy the
    // absence below while proving nothing, which is precisely how its predecessor passed for
    // as long as it existed.
    const sends = wireSends()
    expect(sends.length).toBeGreaterThan(0)
    for (const payload of sends) {
      expect(payload).not.toMatch(/"type"\s*:\s*"build"/)
      expect(payload).not.toMatch(OUTCOME_SENTENCE)
    }
  })

  it('shows a failed build with its reason', async () => {
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    // The reason rides the terminal frame — `self_heal_budget_exhausted`, `sandbox_gone`, and
    // the rest of them.
    await turn.frame(T_BUILD_END({ turnId: 't1', status: 'failed', reason: 'tsc failed after 3 attempts' }))
    await turn.end()

    const card = await findOutcome()
    expect(card.textContent).toMatch(/build failed/i)
    // The reason is what the user can act on — surface it, don't bury it in the feed.
    expect(card.textContent).toMatch(/tsc failed after 3 attempts/i)
  })

  it('warns when a build ran but its code was not saved', async () => {
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    await turn.frame(T_BUILD_END({ turnId: 't1', snapshotCommitted: false }))
    await turn.end()

    // A build that did not save is not a success: the next build will not start from it, and the
    // user has to know that before building on top of it.
    //
    // RE-POINTED AT THE BANNER. This sentence used to live inside the outcome card; it is in the
    // one banner slot above the composer now — derived from the newest build part, so it still
    // survives a reload exactly as the card's version did, and it is where the citizen is
    // standing when they are about to build again on top of it.
    expect((await screen.findByTestId('turn-banner')).textContent).toMatch(/wasn’t saved/i)
  })

  it('a terminal that never reports the save does not claim the code was thrown away', async () => {
    // UNKNOWN IS NOT FALSE: `null`/absent means the terminal never spoke about the save, `false`
    // means the save ran and did not land. Saying nothing is the only honest render of the first,
    // and the server's durable row replaces this one on reload anyway.
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    await turn.frame(T_BUILD_END({ turnId: 't1' })) // completed, and silent about the snapshot
    await turn.end()
    // LIVENESS FIRST: the outcome has to actually be on screen for the absence below to mean
    // anything — `queryByText(...).toBeNull()` also passes on a surface that rendered nothing.
    await findOutcome()

    expect(screen.queryByText(/wasn’t saved/i)).toBeNull()
  })

  it('a user Stop stops the TURN, and its terminal is still recorded', async () => {
    // A build has no session-level stop any more: one working indicator, one way to interrupt it,
    // and it is the same `stopTurn` an ordinary reply uses. The stop is a REQUEST — the terminal
    // still arrives as a frame, and it is that frame the record is written from.
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    // `stop-turn` is the RELOCATED control on the composer, not the one inside the build card.
    // Both are on screen for now and both stop the same turn the same way; this one is addressed
    // by test id because it is the one that survives the card's deletion, so this assertion keeps
    // meaning the same thing afterwards.
    fireEvent.click(await screen.findByTestId('stop-turn'))
    await waitFor(() => expect(h.stopTurn).toHaveBeenCalledWith('thread-1', 't1'))
    expect(h.stop).not.toHaveBeenCalled() // never a session-level stop

    await turn.frame(T_BUILD_END({ turnId: 't1', status: 'stopped', reason: 'stopped_by_user' }))
    await turn.end('completed')
    expect(await findOutcome()).toBeTruthy()
  })

  it('still warns when the terminal explicitly says the snapshot did not commit', async () => {
    // The other half of the tri-state: `false` from the server is a real answer and must keep
    // warning. Only the ABSENCE of an answer is what stops being read as one.
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    await turn.frame(T_BUILD_END({ turnId: 't1', snapshotCommitted: false }))
    await turn.end()

    expect((await screen.findByTestId('turn-banner')).textContent).toMatch(/wasn’t saved/i)
  })

  it('shows nothing while the build is still running', async () => {
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    await turn.frame(T_PREVIEW())

    // LIVENESS, RE-POINTED. It used to read the pane's "preview is live" copy; the pane's cover
    // is driven by `turnPhase` off the frames now, and this harness mounts no pane at all. What
    // the absence below needs is proof the build is genuinely still running, and the composer's
    // stop control is present for exactly and only that.
    await waitFor(() => expect(screen.getByTestId('stop-turn')).toBeTruthy())
    expect(outcomeCards()).toHaveLength(0)
  })
})

describe('dedupe on the build TURN', () => {
  it('does not double-show a replayed terminal frame', async () => {
    const turn = scriptTurn('t1')
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    await runBuild(turn)

    // A resubscribe (resume-once on a dropped socket) re-delivers the terminal it already saw.
    await turn.frame(T_BUILD_END({ turnId: 't1' }), T_BUILD_END({ turnId: 't1' }))
    await turn.end()

    await findOutcome()
    await waitFor(() => expect(outcomeCards()).toHaveLength(1))
  })

  it('does not re-show after a reload, where the server’s row is already in the transcript', async () => {
    // The case an `_id`/seq guard cannot catch: both are fresh after a reload, so only matching on
    // the BUILD TURN tells us this outcome is already recorded.
    //
    // Driven through the REATTACH path (`activeTurn`), not a second ordinary send — an ordinary
    // send always mints a brand-new turn id, so it can never reproduce the one case this guard
    // exists for: the read projection still names `t1` as the live turn (a race — the server had
    // not yet cleared it when this GET ran), the transcript ALREADY holds `t1`'s persisted row,
    // and the reattach's own stream then reports the very same turn ending again.
    h.getBuild.mockResolvedValue({
      id: 'thread-1',
      activeTurn: { turnId: 't1', lastSeq: 5 },
      messages: [
        { id: 'm0', role: 'user', parts: [{ type: 'text', text: 'a visitor app' }], seq: 0 },
        {
          id: 'm1',
          role: 'assistant',
          seq: 1,
          parts: [
            { type: 'text', text: 'Build finished.' },
            { type: 'build', status: 'ended', turnId: 't1', previewUrl: PREVIEW_URL },
          ],
        },
      ],
    })
    const turn = scriptTurn('t1', [])
    h.readTurnStream.mockImplementation(turn.impl)
    renderThread()
    // The stored row renders immediately from the seeded transcript, before the reattach's
    // stream says anything at all. It is the message's TEXT part that carries the sentence — the
    // `build` part beside it maps to no rendered element, which is exactly why the fixture's two
    // parts still produce one readable outcome.
    await findOutcome()

    await waitFor(() => expect(h.readTurnStream).toHaveBeenCalled())
    await turn.frame(T_BUILD_END({ turnId: 't1' }))
    await turn.end()

    expect(outcomeCards()).toHaveLength(1)
  })

  it('shows a SECOND build separately — dedupe is per build turn, not per thread', async () => {
    const first = scriptTurn('t1')
    h.readTurnStream.mockImplementation(first.impl)
    renderThread()
    await runBuild(first)
    await first.frame(T_BUILD_END({ turnId: 't1' }))
    await first.end()
    await findOutcome()

    // An iteration is a NEW turn, and its outcome is its own record — the whole reason the record
    // is keyed by the build rather than by the thread.
    const second = scriptTurn('t2')
    h.readTurnStream.mockImplementation(second.impl)
    await runBuild(second, 'add a chart')
    await second.frame(T_BUILD_END({ turnId: 't2' }))
    await second.end()

    await waitFor(() => expect(outcomeCards()).toHaveLength(2))
  })
})
