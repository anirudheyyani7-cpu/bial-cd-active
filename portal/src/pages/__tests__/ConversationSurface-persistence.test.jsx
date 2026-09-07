/**
 * Build-chat persistence guards, expressed against the current routing rule: a send is a CHAT
 * turn, and the build fires only when the user confirms the returned brief card.
 *
 * What's pinned: the user turn — INCLUDING its attachment parts — persists on the SEND, before
 * the confirmed build starts, so BRAIN reads attachment context server-side. The row's
 * parentage rides the same `POST .../turns` request as a `create` block, letting the server
 * check the workspace before creating anything — see `fireRelayTurn`'s comment in
 * `ConversationSurface.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { FakeEventSource, makeClient, primeClient, PLAN_CARD_ID, primeTurn, waitForGateOpen } from './_builderSession.jsx'

const h = vi.hoisted(() => ({
  loadBuilds: vi.fn(), getBuild: vi.fn(),
  listProjectConversations: vi.fn(), buildUserParts: vi.fn(),
  startTurn: vi.fn(), readTurnStream: vi.fn(), buildFromPlan: vi.fn(),
  resolvePlanOptions: vi.fn(),
  stop: vi.fn(), getStatus: vi.fn(), forceEnd: vi.fn(),
}))

vi.mock('../../utils/builderHistory', () => ({
  loadBuilds: h.loadBuilds, getBuild: h.getBuild, deriveTitle: (t) => (t || '').slice(0, 40),
}))
// SPREAD THE ORIGINAL — `handleBuildIt` mints the build chat's id via the shared `uuidv7`;
// a factory naming only `listProjectConversations` leaves every other export (that one
// included) undefined, and Vitest warns the moment a real caller reaches for it.
vi.mock('../../utils/conversationApi', async (importOriginal) => ({
  ...(await importOriginal()),
  listProjectConversations: h.listProjectConversations,
}))
vi.mock('../../components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../components/LivePreview', () => ({ default: () => null }))
// A rendered file-part message would mount AttachmentChips, which fetches the object URL over the
// real (relative-URL) network — stub it so the transcript render triggers no unhandled fetch.
vi.mock('../../components/AttachmentChips', () => ({ default: () => null }))
vi.mock('../../utils/attachmentStore', async (orig) => ({ ...(await orig()), buildUserParts: h.buildUserParts }))
// `switchMode` is GONE from this list: the route it posted to no longer exists.
vi.mock('../../utils/turnStreamApi', async (orig) => ({
  ...(await orig()),
  startTurn: (...a) => h.startTurn(...a),
  readTurnStream: (...a) => h.readTurnStream(...a),
  buildFromPlan: (...a) => h.buildFromPlan(...a),
  resolvePlanOptions: (...a) => h.resolvePlanOptions(...a),
}))

import ConversationSurface from '../../components/chat/ConversationSurface'

function renderBuilder(chatId = 'build-X') {
  const fake = new FakeEventSource(chatId)
  const deps = { client: makeClient(h), eventSourceFactory: () => fake }
  const view = render(
    <MemoryRouter initialEntries={[`/chat/${chatId}?projectId=p1&kind=build`]}>
      <Routes>
        <Route path="/chat/:chatId" element={<ConversationSurface projectId="p1" projectName="VIP Movement" buildSessionDeps={deps} />} />
        <Route path="/projects/:projectId" element={<div>project home</div>} />
        <Route path="/projects" element={<div>projects index</div>} />
      </Routes>
    </MemoryRouter>,
  )
  return { ...view, fake }
}

/**
 * Drive a build the way a user does: send a turn, then confirm the brief card the model
 * replies with. The send alone only persists the turn and asks the assistant — the click is the
 * page's single build trigger, so `start` sees the refined BRIEF, not `text`.
 */
async function startBuild(text = 'make it blue') {
  await waitForGateOpen()
  const textarea = await screen.findByPlaceholderText(/ask for another change/i)
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.keyDown(textarea, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('button', { name: /^Build this plan$/ }))
  await waitFor(() => expect(h.buildFromPlan).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  primeClient(h)
  h.getBuild.mockResolvedValue(null)
  h.loadBuilds.mockResolvedValue([])
  h.listProjectConversations.mockResolvedValue([])
  h.buildUserParts.mockImplementation(async (text) => [{ type: 'text', text }])
  // A scripted turn that always answers with a ready-to-build brief, so these suites reach the
  // persistence + gating mechanics in one send. Whether the model asks or briefs is the server's
  // own judgment — see `backend/tests/services/agent/test_mode_prompts.py`.
  primeTurn(h)
})
afterEach(() => cleanup())

describe('BuilderPage — the attachment user-turn is persisted before the build starts', () => {
  it('sends the attachment as an OWNED REF on the wire message, WITH the row\'s own create block, before the build starts', async () => {
    // buildUserParts stands in for the upload: it yields a text part + a file part.
    h.buildUserParts.mockImplementation(async (text) => [
      { type: 'text', text },
      { type: 'file', attachmentId: 'a1', kind: 'image', name: 'gate.png', mediaType: 'image/png' },
    ])
    renderBuilder()
    await startBuild('use this layout')

    // The turn reaches the SERVER with the attachment as an owned reference — the
    // server persists it into the thread BRAIN later reads.
    const [, wire, , create] = h.startTurn.mock.calls[0]
    expect(wire.text).toBe('use this layout')
    expect(wire.attachmentIds).toEqual(['a1'])
    // The row's parentage rides this same call as a 4th `create` argument (present because
    // this is the FIRST message on an empty thread), letting the server check the workspace
    // before creating the row at all — see `fireRelayTurn`'s comment in `ConversationSurface.tsx`.
    expect(create).toMatchObject({ projectId: 'p1', kind: 'build' })
    // The single call — message + row parentage together — still happens before the build
    // starts: create+turn → stream → confirm → build.
    expect(h.startTurn.mock.invocationCallOrder[0]).toBeLessThan(
      h.buildFromPlan.mock.invocationCallOrder[0],
    )
  })

  it('passes the chat id as conversationId on start, so the persisted parts reach the build', async () => {
    // The other half of the seam: persisting the parts only matters if start TELLS the server
    // which thread to read them from. Without this the build is text-only and the file is
    // silently ignored — the exact bug this test guards against.
    renderBuilder()
    await startBuild('use the attached sheet')

    // The transition names the THREAD (the server reads the plan + its attachments from it).
    // Third arg is the client-minted id of the NEW build chat the handoff creates —
    // a real `uuidv7()`, so only its shape is pinned here, not its value.
    expect(h.buildFromPlan).toHaveBeenCalledWith('build-X', PLAN_CARD_ID, expect.any(String))
  })

  it('ABORTS the send when the upload fails — never starts a text-only build', async () => {
    h.buildUserParts.mockRejectedValue(new Error('Upload failed: storage is full.'))
    renderBuilder()
    const textarea = await screen.findByPlaceholderText(/ask for another change/i)
    fireEvent.change(textarea, { target: { value: 'use this sheet' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await screen.findByText(/Upload failed: storage is full./i)
    // The turn never reaches the server at all — no `create` block, no message — so no plan
    // comes back and there is nothing to confirm. (No separate `createBuild` call to assert
    // absent: its creation folded into this same, never-attempted `startTurn`.)
    expect(h.startTurn).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Build this plan$/ })).toBeNull()
    expect(h.buildFromPlan).not.toHaveBeenCalled() // no build ignoring the file
  })
})
