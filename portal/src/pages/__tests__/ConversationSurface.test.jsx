/**
 * WHAT U17 ITSELF CLAIMS — the properties of the surface as a whole (R30, R49, R51, R52, R54, R55,
 * R72).
 *
 * The fifteen re-pointed page suites pin the BEHAVIOUR that came across the migration. This file
 * pins the things that are only true of the surface once the deletions have happened, and which no
 * individual behaviour test would notice going wrong:
 *
 *   - a running turn is still STOPPABLE now that the card carrying the old stop is gone (R55).
 *     U3's verification sentence is otherwise a claim about a commit that nothing checks;
 *   - exactly ONE control on the whole surface starts a build (R29a's other half);
 *   - exactly ONE scroll container inside the chat slot, and no `calc(100vh - …)` anywhere (R49);
 *   - no chat list reappeared while the pages around it were being rewritten (R54 is Plan A's;
 *     this is the assertion that it STAYED removed);
 *   - the save-state tri-state is published UNCOLLAPSED, so the shell's unsaved-work guard gets
 *     `null` as `null`.
 *
 * The last of those is the one worth being unhappy about getting wrong. The guard itself is
 * covered in `components/workspace/__tests__/WorkspaceShell.test.tsx` — `true` arms it, `false`
 * and `null` do not, and it never claims "nothing unsaved" from an unknown. What THAT file cannot
 * see is whether this surface hands it a `null` at all, or quietly turns one into a boolean on the
 * way past. This does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const h = vi.hoisted(() => ({
  loadBuilds: vi.fn(), getBuild: vi.fn(),
  listProjectConversations: vi.fn(), buildUserParts: vi.fn(),
  startTurn: vi.fn(), readTurnStream: vi.fn(), buildFromPlan: vi.fn(), stopTurn: vi.fn(),
  resolvePlanOptions: vi.fn(),
  stop: vi.fn(), getStatus: vi.fn(), relaunchPreview: vi.fn(),
  fetchSaveState: vi.fn(), fetchPreviewState: vi.fn(), saveProject: vi.fn(),
}))

vi.mock('../../utils/builderHistory', () => ({
  loadBuilds: h.loadBuilds, getBuild: h.getBuild, deriveTitle: (t) => (t || '').slice(0, 40),
}))
vi.mock('../../utils/conversationApi', async (orig) => ({
  ...(await orig()),
  listProjectConversations: h.listProjectConversations,
}))
vi.mock('../../components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../utils/attachmentStore', async (orig) => ({ ...(await orig()), buildUserParts: h.buildUserParts }))
vi.mock('../../utils/turnStreamApi', async (orig) => ({
  ...(await orig()),
  startTurn: (...a) => h.startTurn(...a),
  readTurnStream: (...a) => h.readTurnStream(...a),
  buildFromPlan: (...a) => h.buildFromPlan(...a),
  stopTurn: (...a) => h.stopTurn(...a),
  resolvePlanOptions: (...a) => h.resolvePlanOptions(...a),
}))
// The save-state read is the PRODUCER of the tri-state this file is about, so it is the one
// transport that must be controllable here.
vi.mock('../../utils/buildSessionApi', async (orig) => ({
  ...(await orig()),
  fetchSaveState: (...a) => h.fetchSaveState(...a),
  // The workspace read, and the start `StartAppControl` imports DIRECTLY from this module rather
  // than through the injected client — both are what the failed-launch scenario at the bottom
  // drives, and leaving either real would put this suite on the network.
  fetchPreviewState: (...a) => h.fetchPreviewState(...a),
  relaunchPreview: (...a) => h.relaunchPreview(...a),
  // The WRITER of the bundle. It is the subject of the deployment-nudge scenario at the
  // bottom, and leaving it real would put this suite on the network there too.
  saveProject: (...a) => h.saveProject(...a),
}))

import {
  FakeEventSource, makeClient, primeClient, primeTurn, renderBuilder, send, waitForGateOpen,
  planReply, turnStreaming, PLAN_CARD_ID, findStartAppControl,
} from './_builderSession.jsx'
import { ApiError } from '../../utils/apiError'
import { DEFAULT_CONTEXT_SOFT } from '../../utils/contextLimits'

const deps = () => {
  const fake = new FakeEventSource('x')
  return { fake, deps: { client: makeClient(h), eventSourceFactory: () => fake } }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  primeClient(h)
  primeTurn(h)
  h.getBuild.mockResolvedValue({ id: 'build-X', kind: 'build', messages: [] })
  h.loadBuilds.mockResolvedValue([])
  h.listProjectConversations.mockResolvedValue([])
  h.buildUserParts.mockImplementation(async (t) => [{ type: 'text', text: t }])
  h.fetchSaveState.mockResolvedValue({ dirty: false })
  h.saveProject.mockResolvedValue({ appId: 'a1', headSha: 'ccc' })
  // Neither the workspace read nor the start is this file's subject by default: answered so
  // nothing reaches a real `fetch`, and re-primed by the two scenarios that are about them.
  h.fetchPreviewState.mockResolvedValue({
    state: 'unknown', alive: false, previewUrl: null,
    occupyingProjectName: null, occupyingProjectId: null, restorable: null,
  })
  h.relaunchPreview.mockResolvedValue({ appId: 'a1', previewUrl: 'https://app/', status: 'ready', ready: true, restoredFromFailedBuild: false })
})
afterEach(cleanup)

describe('R55 — a running turn is STILL stoppable now the card is gone', () => {
  it('the surface renders a stop control and pressing it calls the turn-stop path', async () => {
    // THE SCENARIO THE WHOLE ORDERING EXISTS FOR. U3 shipped the relocated stop before anything
    // was deleted so that no commit in this plan left a build startable and not stoppable; this is
    // what checks the claim AFTER the deletion rather than trusting the sequence.
    // THE SNAPSHOT IS WHAT CARRIES THE TURN ID, and every subscribe gets one first on cursor 0
    // (the server emits it before any model byte). Without it the control resolves no target and
    // correctly falls through to the legacy session stop — a real arm, but not the one under test.
    h.readTurnStream.mockImplementation(async ({ onFrame }) => {
      onFrame({ type: 'snapshot', seq: 1, turnId: 'turn-7', turnStatus: 'running', items: [], parts: [], working: false })
      return new Promise(() => {}) // …and then the turn never lands
    })
    renderBuilder({ deps: deps().deps })
    await send('build me a thing')

    const stop = await screen.findByTestId('stop-turn')
    expect(stop.textContent).toMatch(/stop/i)
    fireEvent.click(stop)
    // The TURN stop, with the conversation and the turn read at PRESS time — never the session's.
    await waitFor(() => expect(h.stopTurn).toHaveBeenCalledWith('build-X', 'turn-7'))
    expect(h.stop).not.toHaveBeenCalled()

    // PAIRED WITH A LIVENESS ASSERTION, because a surface that rendered nothing would also have
    // no build card.
    expect(screen.getByTestId('composer-input')).toBeTruthy()
  })

  it('and nothing on the surface is a build-progress card any more', async () => {
    h.readTurnStream.mockImplementation(() => new Promise(() => {}))
    renderBuilder({ deps: deps().deps })
    await send('build me a thing')
    await screen.findByTestId('stop-turn')

    for (const id of ['build-progress', 'build-bubble', 'build-activity', 'build-outcome', 'plan-options-card']) {
      expect(screen.queryByTestId(id), `${id} is still rendered`).toBeNull()
    }
  })
})

describe('exactly one control initiates a build', () => {
  it('counts the initiators across the WHOLE surface, not the absence of one in a top bar', () => {
    // Written this way deliberately. An assertion that a Build button is "not in the top bar"
    // would pass because the top bar is not in the rendered tree — and would keep passing if
    // someone added one there. Counting has teeth; querying for an element that was never going
    // to be there does not.
    h.readTurnStream.mockImplementation(turnStreaming(planReply('Here is the plan.', PLAN_CARD_ID)))
    return (async () => {
      renderBuilder({ deps: deps().deps })
      await send('plan me a thing')

      const initiators = await screen.findAllByRole('button', { name: /^Build this plan$/ })
      expect(initiators).toHaveLength(1)
      // …and it is on the composer, where the offer lives — not in the transcript.
      expect(screen.getByTestId('composer').contains(initiators[0])).toBe(true)
    })()
  })
})

describe('R49 — one scroll container, and no viewport-height assertions', () => {
  it('exactly one `overflow-y-auto` inside the chat slot', async () => {
    renderBuilder({ deps: deps().deps })
    await waitForGateOpen()

    const panel = screen.getByTestId('chat-panel')
    const scrollers = panel.querySelectorAll('[class*="overflow-y-auto"]')
    // FOUR nested scrollers on the planning page and another on the builder is what this deletes.
    // `#chat-panel` itself is excluded by construction: it is `overflow-hidden`, not a scroller,
    // and it survives.
    expect(scrollers).toHaveLength(1)
    expect(panel.className).toContain('overflow-hidden')
  })

  it('no `calc(100vh - …)` anywhere in the chat surface’s source', () => {
    // The one in `ChatPage.tsx` was the only one in the repo and it died with that file. This is a
    // source-level guard because the failure is a layout that only misbehaves at certain heights —
    // something a jsdom render cannot see at all.
    const src = path.resolve(__dirname, '../..')
    for (const file of ['components/chat/ConversationSurface.tsx', 'components/chat/ChatThread.tsx', 'components/assistant-ui/thread.tsx']) {
      const source = readFileSync(path.join(src, file), 'utf8')
      const offending = source
        .split('\n')
        .filter((line) => /calc\(100vh/.test(line) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      expect(offending, `${file} asserts a viewport height`).toEqual([])
    }
  })
})

describe('R54 — no chat list came back while the pages were being rewritten', () => {
  it('renders no list of conversations, in any state', async () => {
    // Plan A removed the in-chat list; this is the assertion that the rewrite around it did not
    // quietly restore one. Past conversations live on the project page the breadcrumb links to.
    h.listProjectConversations.mockResolvedValue([
      { id: 'other-1', kind: 'build', title: 'Another build', updatedAt: '2026-08-01T00:00:00Z' },
      { id: 'other-2', kind: 'plan', title: 'Some planning', updatedAt: '2026-08-02T00:00:00Z' },
    ])
    renderBuilder({ deps: deps().deps })
    await waitForGateOpen()

    const panel = within(screen.getByTestId('chat-panel'))
    expect(panel.queryByText('Another build')).toBeNull()
    expect(panel.queryByText('Some planning')).toBeNull()
    expect(panel.queryByRole('listbox')).toBeNull()
    // LIVENESS: the surface DID load those conversations — it reads them for the build-blocked
    // advisory — so their absence is a rendering decision rather than a failed fetch.
    await waitFor(() => expect(h.listProjectConversations).toHaveBeenCalled())
  })
})

describe('the save-state TRI-STATE is published uncollapsed', () => {
  /** Ask the browser to leave, and report whether anything objected. */
  const tryToLeave = () => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('a definite `true` reaches the shell and arms the guard', async () => {
    h.fetchSaveState.mockResolvedValue({ dirty: true })
    renderBuilder({ deps: deps().deps })
    await waitFor(() => expect(h.fetchSaveState).toHaveBeenCalled())
    await waitFor(() => expect(tryToLeave()).toBe(true))
  })

  it('a definite `false` does not', async () => {
    h.fetchSaveState.mockResolvedValue({ dirty: false })
    renderBuilder({ deps: deps().deps })
    await waitFor(() => expect(h.fetchSaveState).toHaveBeenCalled())
    expect(tryToLeave()).toBe(false)
  })

  it('an UNKNOWN stays unknown — it is not collapsed into either boolean', async () => {
    // THE CASE THAT MATTERS, and the one this surface could break on its own. `null` means "we
    // could not check", never "clean": collapsing it to `false` reports the work as safe when
    // nobody asked the question, and collapsing it to `true` arms a browser prompt with nothing
    // answerable behind it. The read FAILS here, which is exactly how a `null` arises in
    // production.
    h.fetchSaveState.mockRejectedValue(new Error('the workspace could not be reached'))
    renderBuilder({ deps: deps().deps })
    await waitFor(() => expect(h.fetchSaveState).toHaveBeenCalled())

    expect(tryToLeave()).toBe(false)
    // …and nothing on screen claims the work IS saved, which is the other half of the failure.
    expect(screen.queryByText(/no unsaved|nothing unsaved|all saved|up to date/i)).toBeNull()
  })
})

describe('the per-conversation guardrail reaches the composer', () => {
  // ★ WHY THIS FILE AND NOT A UNIT TEST. `contextLimits.ts` is unit-tested and `Composer`'s
  // rendering of the prop is unit-tested, and BOTH stayed green while the one line joining
  // them was deleted — the whole 1,649-test suite did. That is the same shape as the incident
  // this branch exists to repair: the client-side guardrail died with `ChatPage.tsx` and
  // nothing went red, because what was covered was the parts and never the wiring.
  //
  // So this asserts the SEAM: a long conversation loaded into the surface puts the sentence on
  // the composer. Delete the `contextWarning` prop pass in `ConversationSurface.tsx`, or the
  // `useMemo` that feeds it, and this is what goes red.
  //
  // ══ WHAT "A LONG CONVERSATION" MEANS CHANGED, AND SO DID THIS FIXTURE (#194) ══
  //
  // It used to be a pile of characters: 600,000 of them, priced at four to the token by an
  // estimator this browser ran. That estimator is deleted on both sides — it read a 61-page
  // document as 1,600 tokens when it really cost 153,342 — so a transcript's LENGTH now tells
  // the browser nothing at all, and a fixture built out of characters would be asserting against
  // a guess nobody makes any more.
  //
  // The conversation is long because the SERVER says it is: `contextTokens` on the read is the
  // raw prompt count the provider reported, the same figure the send route refuses on. The wider
  // wiring — the send's own 202, the chat switch, the unmeasured case — is
  // `ConversationSurface-contextmeter.test.tsx`'s; what stays here is the seam this file exists
  // for, in the file that noticed it going missing the first time.
  const conversationOf = (contextTokens) => ({
    id: 'build-X',
    kind: 'build',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'make it nicer' }] }],
    contextTokens,
  })

  it('a conversation past the soft threshold warns on the composer', async () => {
    // The default soft threshold, as the profile-less session resolves it.
    h.getBuild.mockResolvedValue(conversationOf(DEFAULT_CONTEXT_SOFT))
    h.readTurnStream.mockImplementation(() => new Promise(() => {}))
    renderBuilder({ deps: deps().deps })

    const warning = await screen.findByTestId('composer-context-warning')
    expect(warning.textContent).toMatch(/new chat/i)
  })

  it('and an ordinary conversation says nothing', async () => {
    h.getBuild.mockResolvedValue(conversationOf(1_000))
    h.readTurnStream.mockImplementation(() => new Promise(() => {}))
    renderBuilder({ deps: deps().deps })

    // PAIRED WITH A LIVENESS ASSERTION. `queryByTestId(...) === null` is also what a surface
    // that threw would produce, and this repo has been bitten by exactly that: the absence only
    // means something once the composer is proven to be on screen next to it.
    await waitForGateOpen()
    expect(screen.getByTestId('composer-input')).toBeTruthy()
    expect(screen.queryByTestId('composer-context-warning')).toBeNull()
  })

  it('★ and a conversation NOBODY has measured says nothing either', async () => {
    // The honest cost of reading a measurement instead of guessing one: a chat the provider has
    // never served has no figure, and the line stays off rather than being invented. Asserted so
    // that "silent" is a decision on this branch and not an accident of the fixture above.
    h.getBuild.mockResolvedValue(conversationOf(null))
    h.readTurnStream.mockImplementation(() => new Promise(() => {}))
    renderBuilder({ deps: deps().deps })

    await waitForGateOpen()
    expect(screen.getByTestId('composer-input')).toBeTruthy()
    expect(screen.queryByTestId('composer-context-warning')).toBeNull()
  })
})

describe('U9 — the offer\'s Build reaches the SAME hand-over dialog as the composer', () => {
  it('opens the shell\'s dialog naming both projects, in citizen language', async () => {
    // THE THIRD DOOR. Three presses can be refused because another project holds the one
    // workspace — a rail send, the pane's start control, and this one — and the plan asks that
    // they be proven identical rather than correct on the one that was tested. This is the one
    // with no test: it once shipped rendering the refusal as plain red text with no way to act,
    // and a regression there would look exactly like that again while every suite stayed green.
    h.readTurnStream.mockImplementation(turnStreaming(planReply('Here is the plan.', PLAN_CARD_ID)))
    h.buildFromPlan.mockRejectedValue(
      Object.assign(new Error('“Car pool” is still open.'), {
        code: 'sandbox_reclaim_blocked',
        details: { projectId: 'pA', projectName: 'Car pool', dirty: false, building: false },
      }),
    )
    renderBuilder({ deps: deps().deps })
    await send('plan me a thing')

    fireEvent.click(await screen.findByRole('button', { name: /^Build this plan$/ }))

    const dialog = await screen.findByRole('dialog')
    const text = dialog.textContent ?? ''
    // The SAME two names the rail's own scenario asserts (HandoverAtSubmit.test.tsx): the app
    // being started leads, and the one in the way is named so the choice is about something.
    expect(text).toContain('VIP Movement')
    expect(text).toContain('Car pool')
    for (const word of [/container/i, /sandbox/i, /workspace slot/i, /session/i, /409/]) {
      expect(text, String(word)).not.toMatch(word)
    }
  })
})

describe('U11 — a failed launch INSIDE a chat says why', () => {
  it('puts the server\'s reason on the pane, not just a stopped spinner', async () => {
    // The press used to report nothing at all here: the spinner stopped, the same sentence came
    // back, and pressing again did the same thing — because this surface handed the shared map a
    // hardcoded `null` for the outcome on the grounds that it had a relaunch path of its own.
    // That path belongs to a different control. Nothing rendered the pane's own failure, and
    // nothing went red when it did not.
    h.fetchPreviewState.mockResolvedValue({
      state: 'asleep', alive: false, previewUrl: null,
      occupyingProjectName: null, occupyingProjectId: null, restorable: true,
    })
    h.relaunchPreview.mockRejectedValue(
      new ApiError('Your app could not be brought back just now.', 503),
    )
    renderBuilder({ deps: deps().deps })

    fireEvent.click(await findStartAppControl())

    expect(await screen.findByText('We could not start your app.')).toBeTruthy()
    // THE SERVER'S OWN WORDS, carried verbatim — the specific half, and the only thing that tells
    // the citizen what to do differently.
    expect(screen.getByText('Your app could not be brought back just now.')).toBeTruthy()
  })
})

/**
 * ★ A SAVE FROM THE CHAT RAISES THE DEPLOYMENT NUDGE (#205) — the other half of the seam.
 *
 * `savedHead` and `savedAt` are fields of the DEPLOYMENT read, and a Save is what changes them.
 * The surface performing the save holds no such read: the row is drawn by `AppStatusPanel` and
 * the state by the toolbar's publish chip, each with its own `usePublishState`. So the save's only
 * way to correct them is the `bial:deployment-changed` nudge both already listen for.
 *
 * THE PROJECT SCREEN'S SAVE RAISES IT AND THE CHAT'S DID NOT, which is exactly the kind of gap
 * neither side's unit tests can see: `announceDeploymentChanged` is exported and tested, the hook's
 * listener is tested, and the chip stayed one read behind anyway because the one line joining them
 * was missing on this surface. Delete `announceDeploymentChanged(activeProjectId)` from
 * `handleSave` and this is what goes red.
 */
describe('★ a Save from the chat raises the deployment nudge (#205)', () => {
  /** Every nudge the window saw, in order. A CustomEvent is the whole mechanism, so listening for
   *  it is watching the real wire rather than a spy standing in for one. */
  const nudges = []
  const record = (event) => nudges.push(event.detail)
  beforeEach(() => {
    nudges.length = 0
    window.addEventListener('bial:deployment-changed', record)
  })
  afterEach(() => window.removeEventListener('bial:deployment-changed', record))

  it('names the project it saved, and the save itself goes through', async () => {
    // Dirty, or the toolbar's Save is a chip rather than a button and the press does nothing.
    h.fetchSaveState.mockResolvedValue({ dirty: true })
    renderBuilder({ deps: deps().deps })

    fireEvent.click(await screen.findByTestId('save-project'))

    // LIVENESS FIRST: the save actually happened. Without this the nudge assertion below would
    // stay green over a Save that never wrote anything — an event about nothing.
    await waitFor(() => expect(h.saveProject).toHaveBeenCalledWith('p1'))
    // …and the toolbar has taken the answer, so the press ran to completion rather than throwing.
    expect(await screen.findByText('Saved')).toBeTruthy()

    // THE NUDGE, ONCE, NAMING THIS PROJECT. The id is the whole payload a listener acts on: a
    // nudge for someone else's project is one every mount here correctly ignores.
    await waitFor(() => expect(nudges).toHaveLength(1))
    expect(nudges[0].projectId).toBe('p1')
  })
})
