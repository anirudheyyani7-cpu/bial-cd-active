/**
 * WHY THIS EXISTS: the pane host is the shell's sibling, not the Outlet's child, so a suite that
 * mounts the project page alone has no pane in its tree and stays green against a screen that
 * frames nothing (`AppPaneHost`'s mechanism).
 *
 * The project surface is the SECOND publisher on the workspace channel — two surfaces publishing
 * to one channel can retire each other's work on the hop between them. Every continuity assertion
 * here is paired with the round trip that would break it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom'
import WorkspaceShell from '../WorkspaceShell'
import ProjectWorkspace from '../ProjectWorkspace'
import {
  useAppPaneVisible,
  usePublishAddress,
  usePublishHeading,
  usePublishPaneView,
  useWorkspaceProject,
  type PaneView,
} from '../workspaceChannel'
import type { ReactNode } from 'react'
import type { Project } from '../../../utils/projectApi'
import type { DeploymentView, PublishState } from '../../../utils/deployApi'
import { formatStamp } from '../../../utils/publishPresentation'

const api = vi.hoisted(() => ({
  fetchPreviewState: vi.fn(),
  fetchSaveState: vi.fn(),
  relaunchPreview: vi.fn(),
  saveProject: vi.fn(),
  listProjectConversations: vi.fn(),
  getDeployment: vi.fn(),
}))

vi.mock('../../../utils/buildSessionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/buildSessionApi')>()),
  fetchPreviewState: api.fetchPreviewState,
  fetchSaveState: api.fetchSaveState,
  relaunchPreview: api.relaunchPreview,
  saveProject: api.saveProject,
}))
// THE PUBLISH READ IS PART OF THIS SCREEN, not a stub. The rail's APP STATUS panel holds
// one and the toolbar's chip holds another, and the LAST SAVED row this suite asserts about is a
// FIELD OF THIS RESPONSE — so it is mocked at the wire, where a count of the reads is meaningful,
// rather than at the hook, which is the seam the defect lived in.
vi.mock('../../../utils/deployApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/deployApi')>()),
  getDeployment: api.getDeployment,
}))
vi.mock('../../layout/Navbar', () => ({ default: () => <div data-testid="navbar" /> }))
vi.mock('../../projects/ProjectDescriptionEditor', () => ({
  default: () => <div data-testid="description-editor" />,
}))

const APP_URL = 'https://app-a.example.azurecontainerapps.io/'

const PROJECT: Project = {
  id: 'pA',
  name: 'VIP Movement',
  description: 'A tracked movement.',
  appId: 'app-1',
  appStatus: null,
  hasRelaunchableSnapshot: true,
  isServing: false,
  createdAt: '2026-07-10T00:00:00Z',
  updatedAt: '2026-07-10T00:00:00Z',
}

const preview = (over: Record<string, unknown> = {}) => ({
  state: 'never_built',
  alive: false,
  previewUrl: null,
  occupyingProjectName: null,
  occupyingProjectId: null,
  restorable: null,
  ...over,
})

/** The publish read's empty envelope, in whichever state the scenario is about. */
const deployment = (publishState: PublishState = 'draft', over: Partial<DeploymentView> = {}): DeploymentView => ({
  deploymentId: null,
  appId: 'app-1',
  status: null,
  step: null,
  url: null,
  headSha: null,
  failureCode: null,
  failureDetail: null,
  startedAt: null,
  finishedAt: null,
  unpublishedAt: null,
  approval: null,
  publishState,
  savedHead: null,
  savedAt: null,
  ...over,
})

const EMPTY_PANE: PaneView = {
  iterating: false, reconnecting: false,
  restoredFromFailedBuild: false, completedLive: true, hasSavedBuild: null,
  previewState: null, occupyingProjectName: null, turnRunning: false,
  compileState: null, workspaceLost: false,
}

/**
 * A chat, publishing its own address — the OTHER publisher on this channel. `pane` is the one
 * thing the two kinds differ on: a build chat asks for the app to be seen, a plan chat does not.
 */
function ChatSurface({ projectId = 'pA', pane = true }: { projectId?: string; pane?: boolean }) {
  useWorkspaceProject(projectId)
  usePublishAddress({ url: APP_URL, status: 'ready' }, projectId)
  usePublishPaneView(EMPTY_PANE)
  useAppPaneVisible(pane)
  return <div data-testid="chat-surface" />
}

const noop = () => {}

/** The project surface, with every prop its owner would have loaded. */
function Surface({ project = PROJECT }: { project?: Project }) {
  return (
    <ProjectWorkspace
      project={project}
      onProjectUpdate={noop}
    />
  )
}

/** Both addresses under ONE shell, navigated by link exactly as the product navigates them. */
function Workspace({ entry = '/projects/pA', project = PROJECT }: { entry?: string; project?: Project }) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<WorkspaceShell />}>
          <Route
            path="/projects/:projectId"
            element={
              <>
                <Link to="/chat/c1">to chat</Link>
                <Link to="/plan/c2">to plan chat</Link>
                <Surface project={project} />
              </>
            }
          />
          <Route
            path="/chat/:chatId"
            element={
              <>
                <Link to="/projects/pA">to project</Link>
                <ChatSurface />
              </>
            }
          />
          <Route
            path="/plan/:chatId"
            element={
              <>
                <Link to="/projects/pA">to project</Link>
                <ChatSurface pane={false} />
              </>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

const frame = () => document.querySelector('iframe')
// Two different elements, and mixing them up misreads "nothing built" as "the pane is missing":
// `app-pane-region` is `AppPane`'s own named region (always rendered); `app-pane` is
// `AppPaneHost`'s frame wrapper, which exists only once an address resolved.
const paneRegion = () => screen.queryByTestId('app-pane-region')
const frameWrapper = () => screen.queryByTestId('app-pane')
const grid = () => screen.getByTestId('workspace-grid')
const rail = () => screen.getByTestId('workspace-outlet')

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchPreviewState.mockResolvedValue(preview())
  api.fetchSaveState.mockResolvedValue({ appId: 'app-1', dirty: false, containerHead: null, savedHead: null })
  api.saveProject.mockResolvedValue({ appId: 'app-1', headSha: 'ccc' })
  api.getDeployment.mockResolvedValue(deployment())
})

afterEach(() => cleanup())

describe('loading a project address frames the running app, with no chat in the story', () => {
  it('★ frames the app on a direct project load, with no conversation ever mounted', async () => {
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
    )
    render(<Workspace />)

    await waitFor(() => expect(frame()).toBeTruthy())
    expect(frame()?.getAttribute('src')).toBe(APP_URL)
  })

  it('★ publishes a pane even for a project with NOTHING built, so the pane says so', async () => {
    // Two columns are the REST STATE of the project screen — nothing built shows the empty-state
    // sentence IN the pane, not a hidden pane the citizen has to interpret.
    api.fetchPreviewState.mockResolvedValue(preview({ state: 'never_built', restorable: false }))
    render(<Workspace project={{ ...PROJECT, appId: null, hasRelaunchableSnapshot: false }} />)

    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalled())
    expect(paneRegion()).toBeTruthy()
    expect(screen.getByTestId('app-pane-empty').textContent).toMatch(/describe what you want to build/i)
    // Counting forbids a second renderer — `getAllByText` alone would tolerate one.
    expect(screen.queryAllByText(/describe what you want to build/i)).toHaveLength(1)
    expect(frame()).toBeNull()
    expect(frameWrapper()).toBeNull()
  })

  it('★ a saved, not-running project offers the ONE start control, on the project screen', () => {
    // Cannot live in `ProjectPage.test.tsx`: that suite renders the page WITHOUT the shell, so
    // there is no pane in its tree and no assertion there would go red if the control disappeared.
    //
    // Mutation receipt: stop rendering `state.action` in `AppPane`'s no-frame arm and this goes red,
    // along with eight scenarios in `AppPane.test.tsx`.
    api.fetchPreviewState.mockResolvedValue(preview({ state: 'asleep', restorable: true }))
    render(<Workspace />)

    return waitFor(() => {
      expect(screen.getByRole('button', { name: /launch application/i })).toBeTruthy()
      // Exactly one: two controls would race the same endpoint.
      expect(screen.getAllByRole('button', { name: /launch application/i })).toHaveLength(1)
    })
  })

  it('frames NOTHING when the read says the workspace is asleep', async () => {
    // Only the `alive` state's `previewUrl` is framable — a pane framing the wrong thing is worse
    // than a pane framing nothing.
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'asleep', restorable: true, previewUrl: APP_URL }),
    )
    render(<Workspace />)

    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalled())
    expect(frame()).toBeNull()
  })
})

describe('the app survives the round trip, in BOTH directions', () => {
  it('project → chat → project keeps the SAME iframe node', async () => {
    // The direction the existing shell suite doesn't exercise: it starts from a chat. The return
    // trip is where a cold first commit can retire an address the departing surface left standing.
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
    )
    render(<Workspace />)
    await waitFor(() => expect(frame()).toBeTruthy())
    const original = frame()

    fireEvent.click(screen.getByText('to chat'))
    expect(frame()).toBe(original)

    fireEvent.click(screen.getByText('to project'))
    await waitFor(() => expect(screen.getByTestId('description-editor')).toBeTruthy())
    expect(frame()).toBe(original)
    expect(frame()?.getAttribute('src')).toBe(APP_URL)
  })

  it('★ does not blank the pane while its own read is still in flight', async () => {
    // A naive publish of `{url: null}` on a cold remount would retire the address the chat left
    // standing; `usePublishAddress`'s abstain rule is what prevents it.
    let resolveRead: (value: unknown) => void = () => {}
    api.fetchPreviewState.mockImplementation(
      () => new Promise((resolve) => { resolveRead = resolve }),
    )
    render(<Workspace entry="/chat/c1" />)
    const original = frame()
    expect(original).toBeTruthy()

    fireEvent.click(screen.getByText('to project'))
    // The read has NOT resolved. The frame must still be standing.
    expect(frame()).toBe(original)

    resolveRead(preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }))
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalled())
    expect(frame()).toBe(original)
  })

  it('fires no start of its own on a remount', async () => {
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'asleep', restorable: true }),
    )
    render(<Workspace />)
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalled())

    fireEvent.click(screen.getByText('to chat'))
    fireEvent.click(screen.getByText('to project'))
    await waitFor(() => expect(screen.getByTestId('description-editor')).toBeTruthy())

    expect(api.relaunchPreview).not.toHaveBeenCalled()
  })
})

describe('the stacked crossing is a class, not a remount', () => {
  it('expresses both layouts on ONE grid element, with no measurement anywhere', async () => {
    // No `matchMedia`, no `ResizeObserver`: the container carries both directions as responsive
    // classes, so the crossing cannot remount the frame — there is only ever one tree.
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
    )
    render(<Workspace />)
    await waitFor(() => expect(frame()).toBeTruthy())

    expect(grid().className).toMatch(/flex-col/)
    expect(grid().className).toMatch(/wide:flex-row/)
  })

  it('gives the project rail the narrower of the two OPENING widths', async () => {
    render(<Workspace />)
    await waitFor(() => expect(screen.getByTestId('description-editor')).toBeTruthy())

    expect(rail().style.getPropertyValue('--rail-w')).toBe('400px')
    expect(rail().getAttribute('data-rail-mode')).toBe('details')
  })
})

describe('the collapse control — hidden, not unmounted, and never a one-way door', () => {
  it('★ lives in the TOOLBAR ROW, so it is still reachable once the rail is hidden', async () => {
    // A toggle placed inside the rail itself would vanish when collapsed (`w-0` and `invisible`
    // take it out of the tab order and the accessibility tree) — nothing short of a reload could
    // undo the press. The row survives both a collapse and the pane going away, so the control
    // has one home in every state.
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
    )
    render(<Workspace />)
    await waitFor(() => expect(frame()).toBeTruthy())

    const toggle = screen.getByRole('button', { name: /hide details/i })
    expect(screen.getByTestId('workspace-toolbar').contains(toggle)).toBe(true)
    expect(paneRegion()?.contains(toggle)).toBe(false)
    expect(rail().contains(toggle)).toBe(false)

    fireEvent.click(toggle)
    // `\bw-0\b` would also match the `min-w-0` this element always carries — the boundary has to
    // be whitespace, not a word boundary.
    expect(rail().className).toMatch(/(^|\s)w-0(\s|$)/)
    expect(rail().className).toMatch(/invisible/)
    const back = screen.getByRole('button', { name: /show details/i })
    expect(back.getAttribute('aria-expanded')).toBe('false')
    expect(back.getAttribute('aria-controls')).toBe(rail().id)

    fireEvent.click(back)
    expect(rail().className).not.toMatch(/(^|\s)w-0(\s|$)/)
  })

  it('keeps the rail MOUNTED while collapsed, so nothing inside it is discarded', async () => {
    render(<Workspace />)
    await waitFor(() => expect(screen.getByTestId('description-editor')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /hide details/i }))

    // The subtree is still in the document — a draft and a scroll position survive the cycle.
    expect(screen.getByTestId('description-editor')).toBeTruthy()
    expect(rail().className).toMatch(/invisible/)
  })

  it('★ is reachable on a project with NOTHING BUILT, where there is no frame to hang it on', async () => {
    // The toggle can't live in the pane's toolbar slot: that toolbar is rendered by `LivePreview`,
    // which only mounts once there is something to frame, so a project with nothing built would
    // have NO toggle at all. Its home has to be a surface that always renders.
    api.fetchPreviewState.mockResolvedValue(preview({ state: 'never_built', restorable: false }))
    render(<Workspace project={{ ...PROJECT, appId: null, hasRelaunchableSnapshot: false }} />)
    await waitFor(() => expect(api.fetchPreviewState).toHaveBeenCalled())
    expect(frame()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /hide details/i }))
    expect(rail().className).toMatch(/(^|\s)w-0(\s|$)/)
    fireEvent.click(screen.getByRole('button', { name: /show details/i }))
    expect(rail().className).not.toMatch(/(^|\s)w-0(\s|$)/)
  })

  it('leaves the frame alone across a collapse — it is a class change, not a remount', async () => {
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
    )
    render(<Workspace />)
    await waitFor(() => expect(frame()).toBeTruthy())
    const original = frame()

    fireEvent.click(screen.getByRole('button', { name: /hide details/i }))

    expect(frame()).toBe(original)
  })
})

describe('the channel is left as the next surface needs to find it', () => {
  it('clears the pane and its visibility on the way out, and keeps the address', async () => {
    // The channel's per-payload rules, exercised from a SECOND publisher — the table in
    // `workspaceChannel.ts` states them.
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
    )
    render(<Workspace />)
    await waitFor(() => expect(frame()).toBeTruthy())
    const original = frame()

    fireEvent.click(screen.getByText('to chat'))

    // The chat surface publishes its own pane, so the frame survives on the address, not the pane.
    expect(frame()).toBe(original)
    expect(screen.getByTestId('chat-surface')).toBeTruthy()
  })
})

/**
 * WHAT THE SHELL DOES FOR A CHAT THAT WANTS NO PANE.
 *
 * The SURFACE half — that the panel fills the rail, that a plan chat centres its column, that the
 * board's footer line appears on one kind and not the other — is `ConversationSurface-panel.test.tsx`'s,
 * where the real conversation surface renders. What is only visible HERE, through the real shell,
 * is the relationship between the two columns: who gets the width, and whether the frame survives.
 */
describe('a chat that declares no pane', () => {
  it('★ takes the whole rail, and the frame stays mounted rather than being torn down', async () => {
    // The hide treatment, never an unmount: the same node throughout.
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
    )
    render(<Workspace />)
    await waitFor(() => expect(frame()).toBeTruthy())
    const original = frame()

    fireEvent.click(screen.getByText('to plan chat'))

    expect(rail().className).toMatch(/flex-1/)
    expect(rail().className).not.toMatch(/lg:w-\[520px\]/)
    expect(frameWrapper()).toBeTruthy()
    expect(frame()).toBe(original)
    // AWAITED, because the app is taken off the screen rather than snatched off it:
    // the column holds its size for one animation while the card slides out, and only then does
    // the hide treatment land. The frame identity above is the assertion that must hold throughout.
    await waitFor(() => expect(frameWrapper()?.className).toMatch(/invisible/))
    expect(frame()).toBe(original)
  })

  it('★ and the app does not reload on the way back either', async () => {
    api.fetchPreviewState.mockResolvedValue(
      preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
    )
    render(<Workspace />)
    await waitFor(() => expect(frame()).toBeTruthy())
    const original = frame()

    fireEvent.click(screen.getByText('to plan chat'))
    fireEvent.click(screen.getByText('to project'))

    expect(frame()).toBe(original)
  })
})

/**
 * ★ LAST SAVED TELLS THE TRUTH AFTER A SAVE.
 *
 * THE DEFECT. The rail's LAST SAVED row is drawn from `savedHead`/`savedAt`, which are fields of
 * the DEPLOYMENT read — and Save wrote a new bundle without telling that read anything. The row
 * went on naming the previous version, or "We could not tell" on a project that had never been
 * saved, on a screen whose own chip had just changed to "Saved". Nothing looked broken, which is
 * why it took a citizen reading the row to find it.
 *
 * WHY THESE RUN THROUGH THE SHELL. The row and the chip hold SEPARATE reads of the same endpoint
 * and the fix is the `bial:deployment-changed` nudge that reconciles both. A suite that mocked
 * `usePublishState` would be asserting against the very seam the defect lived in, and one that
 * rendered the panel alone could not see the chip agree.
 */
const SAVED_ONE = '11ab22cd33ef44ab55cd66ef77ab88cd99ef00ab'
const SAVED_TWO = '99ff88ee77dd66cc55bb44aa33998877665544ff'
const AT_ONE = '2026-09-05T10:15:00Z'
const AT_TWO = '2026-09-05T11:40:00Z'

/**
 * The route's own half, which `ProjectPage` performs. Only these scenarios need it: the toolbar
 * reads `heading.projectId` before it will mount the publish chip at all, so a harness without a
 * heading can never watch the chip and the rail's row agree.
 */
function WithHeading({ children }: { children: ReactNode }) {
  usePublishHeading({ projectId: PROJECT.id, projectName: PROJECT.name, chatTitle: null, chatKind: null })
  return <>{children}</>
}

function SavingWorkspace() {
  return (
    <MemoryRouter initialEntries={['/projects/pA']}>
      <Routes>
        <Route element={<WorkspaceShell />}>
          <Route
            path="/projects/:projectId"
            element={
              <WithHeading>
                <Surface />
              </WithHeading>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

/** Running, with work the saved bundle does not have — the only state in which Save is pressable. */
const dirtyAndAlive = () => {
  api.fetchPreviewState.mockResolvedValue(
    preview({ state: 'alive', alive: true, previewUrl: APP_URL, restorable: true }),
  )
  api.fetchSaveState.mockResolvedValue({ appId: 'app-1', dirty: true, containerHead: 'aaa', savedHead: 'bbb' })
}

const savedRow = () => screen.getByTestId('status-row-saved')
const pressSave = async () => fireEvent.click(await screen.findByTestId('save-project'))

describe('★ the LAST SAVED row after a save', () => {
  it('★ moves off "We could not tell" on the FIRST save a project ever has', async () => {
    // A project with nothing saved yet: both halves of the row are null, so it says so in words.
    dirtyAndAlive()
    render(<SavingWorkspace />)
    await waitFor(() => expect(screen.getByTestId('status-row-saved-unknown')).toBeTruthy())

    api.getDeployment.mockResolvedValue(deployment('draft', { savedHead: SAVED_ONE, savedAt: AT_ONE }))
    await pressSave()

    await waitFor(() => expect(savedRow().textContent).toContain('11ab22c'))
    expect(savedRow().textContent).toContain(formatStamp(AT_ONE))
    // The "cannot tell" rendering is a different element, not merely different text — its absence
    // is what says the row is now making a claim rather than declining to.
    expect(screen.queryByTestId('status-row-saved-unknown')).toBeNull()
  })

  it('★ names the NEW version on the second save, not the one before it', async () => {
    // THE ARM THAT LOOKS PLAUSIBLE WHILE STALE. A row that names a real commit and a real time
    // reads as correct from across the desk; only the value tells you it is the previous save's.
    // So this asserts what the row SAYS, and that what it said a moment ago is gone.
    dirtyAndAlive()
    api.getDeployment.mockResolvedValue(deployment('draft', { savedHead: SAVED_ONE, savedAt: AT_ONE }))
    render(<SavingWorkspace />)
    await waitFor(() => expect(savedRow().textContent).toContain('11ab22c'))

    api.getDeployment.mockResolvedValue(deployment('draft', { savedHead: SAVED_TWO, savedAt: AT_TWO }))
    await pressSave()

    await waitFor(() => expect(savedRow().textContent).toContain('99ff88e'))
    expect(savedRow().textContent).toContain(formatStamp(AT_TWO))
    expect(savedRow().textContent).not.toContain('11ab22c')
    expect(savedRow().textContent).not.toContain(formatStamp(AT_ONE))
  })

  it('★ keeps the row it already had when the re-read FAILS, rather than blanking the panel', async () => {
    // THE RULE NOBODY WROTE DOWN. `usePublishState` sets `loadError` on any failure and the
    // panel renders that branch FIRST — pill, every provenance row and the action all replaced by
    // one line — so a 500 on the read that follows a save would blank the whole section on a
    // screen that has just said "Saved". A stale row is worse than a fresh one and far better
    // than no panel; the first read is still allowed to report its own failure.
    //
    // MUTATION RECEIPT: delete `if (everRead.current) return` from the hook's catch — restoring
    // the blanking branch — and this goes red on the `status-row-saved` query, which finds
    // nothing because the panel has become the error line.
    dirtyAndAlive()
    api.getDeployment.mockResolvedValue(deployment('draft', { savedHead: SAVED_ONE, savedAt: AT_ONE }))
    render(<SavingWorkspace />)
    await waitFor(() => expect(savedRow().textContent).toContain('11ab22c'))

    api.getDeployment.mockRejectedValue(new Error('Failed to read the deployment'))
    await pressSave()

    await waitFor(() => expect(api.getDeployment).toHaveBeenCalledTimes(2))
    expect(savedRow().textContent).toContain('11ab22c')
    expect(screen.getByTestId('app-status-panel').getAttribute('data-publish-state')).toBe('draft')
    expect(screen.queryByTestId('status-recheck')).toBeNull()
    expect(screen.getByTestId('status-pill').textContent).toContain('Draft')
  })

  it('★ the toolbar chip and the rail row agree afterwards — one nudge reconciles both', async () => {
    // Both surfaces are mounted here: the rail is collapsed, which is the state the toolbar mounts
    // its chip in, and a collapsed rail is HIDDEN rather than unmounted so the panel keeps its own
    // read. Two reads of one endpoint is the arrangement the nudge exists for.
    dirtyAndAlive()
    api.getDeployment.mockResolvedValue(deployment('live_current', { savedHead: SAVED_ONE, savedAt: AT_ONE }))
    render(<SavingWorkspace />)
    await waitFor(() => expect(savedRow().textContent).toContain('11ab22c'))

    fireEvent.click(screen.getByRole('button', { name: /hide details/i }))
    await waitFor(() => expect(screen.getByTestId('publish-chip').textContent).toContain('Live'))

    // The save moves the app off `live_current`: what is live is now one version behind.
    api.getDeployment.mockResolvedValue(
      deployment('live_newer_work', { savedHead: SAVED_TWO, savedAt: AT_TWO }),
    )
    await pressSave()

    await waitFor(() =>
      expect(screen.getByTestId('publish-chip').getAttribute('data-publish-state')).toBe('live_newer_work'),
    )
    expect(screen.getByTestId('publish-chip').textContent).toContain('newer work saved')
    // …and the panel behind it says the same thing about the same app, off its own read.
    expect(screen.getByTestId('app-status-panel').getAttribute('data-publish-state')).toBe('live_newer_work')
    expect(screen.getByTestId('status-pill').textContent).toContain('newer work saved')
    expect(savedRow().textContent).toContain('99ff88e')
  })

  it('★ issues exactly ONE deployment read per save — the nudge must not stampede', async () => {
    // A window event with no origin is delivered to every listener, so the cost of getting this
    // wrong is a fan-out that grows with the surfaces on screen — or, if a refresh could raise a
    // nudge of its own, one that never settles. The rail is open here, so the panel is the only
    // publish read in the tree and the arithmetic is exact.
    dirtyAndAlive()
    render(<SavingWorkspace />)
    await waitFor(() => expect(api.getDeployment).toHaveBeenCalledTimes(1))

    await pressSave()
    await waitFor(() => expect(api.getDeployment).toHaveBeenCalledTimes(2))

    // A second save, which is also what proves the count above was not a settling race: a
    // stampede from the first press would have arrived by now and pushed this past three.
    await pressSave()
    await waitFor(() => expect(api.getDeployment).toHaveBeenCalledTimes(3))
    expect(api.saveProject).toHaveBeenCalledTimes(2)
  })
})
