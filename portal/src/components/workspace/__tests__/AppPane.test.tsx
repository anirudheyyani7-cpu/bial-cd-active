/**
 * THE APP PANE (Plan F, U4) — what it is called, how to get past it, and what it says instead.
 *
 * ═══ THE TRAP THIS FILE EXISTS FOR ═══
 *
 * U4 removes the four start affordances that lived inside `LivePreview`'s no-frame placeholders.
 * Those were, until this plan, the ONLY way to bring a stopped app back. An inertness-only
 * assertion — "the old strings are gone" — passes just as happily on a screen with no start control
 * at all, which would satisfy R3's "exactly one control starts it" with zero. So every no-frame
 * state that used to carry one is asserted here for the affordance's PRESENCE, not its absence.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AppPane from '../AppPane'
import { WORKSPACE_RAIL_ID } from '../railId'
import {
  WorkspaceChannelProvider,
  createWorkspaceChannel,
  type WorkspaceChannel,
  type WorkspaceReport,
} from '../workspaceChannel'
import { resolveWorkspaceState, type StartOutcome } from '../workspaceState'
import { ApiError } from '../../../utils/apiError'
import type { HandoverStep, PreviewState } from '../../../utils/buildSessionApi'

const api = vi.hoisted(() => ({ relaunchPreview: vi.fn(), handOverWorkspace: vi.fn() }))

vi.mock('../../../utils/buildSessionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/buildSessionApi')>()),
  relaunchPreview: api.relaunchPreview,
  handOverWorkspace: api.handOverWorkspace,
}))

const STARTED = {
  appId: 'a1', previewUrl: 'https://app/', status: 'ready', restoredFromFailedBuild: false, ready: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  api.relaunchPreview.mockResolvedValue(STARTED)
  api.handOverWorkspace.mockResolvedValue(undefined)
})

const reading = (over: Partial<PreviewState> = {}): PreviewState => ({
  state: 'asleep',
  alive: false,
  previewUrl: null,
  occupyingProjectName: null,
  occupyingProjectId: null,
  restorable: null,
  ...over,
})

function reportFor(
  preview: PreviewState | null,
  startOutcome: StartOutcome | null = null,
  startInFlight = false,
): WorkspaceReport {
  return {
    state: resolveWorkspaceState({ preview, projectHasSavedBuild: null, startOutcome, startInFlight }),
    projectId: 'p1',
    onStarted: vi.fn(),
    onStartPending: vi.fn(),
    onStartOutcome: vi.fn(),
    onRefresh: vi.fn(),
    onReclaimRefusal: vi.fn(),
  }
}

/**
 * The pane under a channel primed exactly as a mounted surface would have left it.
 *
 * THE VISIBILITY IS PRIMED TOO, and it has to be: a mounted surface declares it (the project screen
 * unconditionally, a chat for every kind but `plan`), and the channel's resting value is `false`.
 * Leaving it at rest here would test the pane in a state no surface on screen ever puts it in —
 * every state below is one a citizen is LOOKING at.
 */
function renderPane(prime: (channel: WorkspaceChannel) => void, paneVisible = true) {
  const channel = createWorkspaceChannel()
  channel.visible.set(paneVisible)
  prime(channel)
  const result = render(
    <MemoryRouter>
      {/* The rail the skip control moves focus to — the shell owns it in the product; here it is
          stood up so the focus assertion is about the behaviour rather than about a missing node. */}
      <div id={WORKSPACE_RAIL_ID}>
        <button type="button">a rail control</button>
      </div>
      <WorkspaceChannelProvider value={channel}>
        <AppPane device="Desktop" reloadNonce={0} />
      </WorkspaceChannelProvider>
    </MemoryRouter>,
  )
  return { ...result, channel }
}

const region = () => screen.getByTestId('app-pane-region')

/** What a mounted surface publishes for the pane's chrome — every field at its resting value. */
const PANE_VIEW = {
  iterating: false, reconnecting: false,
  hasSavedBuild: null,
  previewState: null, occupyingProjectName: null, turnRunning: false,
  compileState: null, workspaceLost: false,
}

afterEach(() => cleanup())

describe('the pane says what it is, and a keyboard can get past it', () => {
  it('is a named region', () => {
    renderPane((c) => c.workspace.set(reportFor(reading())))
    expect(region().getAttribute('aria-label')).toBe('Your app')
  })

  it('★ offers a way past the frame, and it moves focus to the rail', () => {
    // An iframe swallows the tab sequence into a cross-origin document whose length nothing here
    // can know and whose focus behaviour is the generated app's business — so a way out has to
    // exist OUTSIDE it. Without one a person navigating by keyboard is trapped in somebody else's
    // application.
    renderPane((c) => c.workspace.set(reportFor(reading())))

    fireEvent.click(screen.getByRole('button', { name: /skip past your app/i }))
    expect(document.activeElement?.id).toBe(WORKSPACE_RAIL_ID)
  })

  it('makes no claim about the framed document itself', () => {
    // The pane says what IT is. What is inside is the generated app's business, and a label
    // promising otherwise would be a claim nothing here can keep.
    renderPane((c) => c.workspace.set(reportFor(reading({ state: 'alive', alive: true }))))
    expect(region().getAttribute('aria-label')).not.toMatch(/accessible|screen reader/i)
  })
})

describe('★ NOT ORPHANED — every no-frame state still offers a way to start the app', () => {
  // The four states that used to carry a `RelaunchAffordance` inside `LivePreview`. Asserting the
  // old strings are absent would pass on a pane with no control at all; this asserts PRESENCE.
  const restorable = [
    ['asleep, with a saved copy', reading({ state: 'asleep', restorable: true })],
    ['never built, but restorable', reading({ state: 'never_built', restorable: true })],
  ] as const

  for (const [name, preview] of restorable) {
    it(`offers the one start control: ${name}`, () => {
      renderPane((c) => c.workspace.set(reportFor(preview)))
      expect(screen.getByRole('button', { name: /launch application/i })).toBeTruthy()
    })
  }

  const retryable: [string, PreviewState | null, StartOutcome | null][] = [
    ['the state could not be read', reading({ state: 'unknown' }), null],
    ['the start did not paint', reading({ state: 'asleep' }), { kind: 'not-painted' }],
    ['the start timed out', reading({ state: 'asleep' }), { kind: 'timed-out' }],
    ['the start failed with a reason', reading({ state: 'asleep' }), { kind: 'failed', reason: 'no image' }],
  ]

  for (const [name, preview, outcome] of retryable) {
    it(`offers a retry: ${name}`, () => {
      renderPane((c) => c.workspace.set(reportFor(preview, outcome)))
      expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
    })
  }

  it('offers the REMEDY, not a retry, when another project holds the workspace', () => {
    renderPane((c) =>
      c.workspace.set(
        reportFor(reading({ state: 'slot_taken', occupyingProjectName: 'Roster', occupyingProjectId: 'p-9' })),
      ),
    )
    expect(screen.getByRole('button', { name: /open “Roster”/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  it('offers NOTHING for the two states where nothing can be pressed', () => {
    for (const preview of [reading({ state: 'never_built', restorable: false }), reading({ state: 'starting' })]) {
      const { unmount } = renderPane((c) => c.workspace.set(reportFor(preview)))
      expect(screen.queryByRole('button', { name: /launch application|try again|open /i })).toBeNull()
      // Liveness: it still SAYS something. An absence assertion alone passes on a blank pane.
      expect(screen.getByTestId('app-pane-empty').textContent?.length).toBeGreaterThan(10)
      unmount()
    }
  })
})

describe('the seam is the resolved address, not a URL that happens to be in hand', () => {
  it('frames the host once an address is resolved, and shows no sentence over it', () => {
    const { container } = renderPane((c) => {
      c.workspace.set(reportFor(reading({ state: 'alive', alive: true })))
      c.address.set({ url: 'https://app.example/', status: 'ready', serving: true, projectId: 'p1' })
      c.project.set('p1')
      c.visible.set(true)
    })

    expect(container.querySelector('iframe')).toBeTruthy()
    expect(screen.queryByTestId('app-pane-empty')).toBeNull()
  })

  it('mounts NO iframe of its own when there is no address', () => {
    // A second host is the remount AE4 and AE37 exist to forbid: the app would reload on every
    // navigation and every crossing of the layout threshold, with nothing red anywhere.
    const { container } = renderPane((c) => c.workspace.set(reportFor(reading())))
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('says nothing at all when nobody has computed a state', () => {
    // A surface mounted outside a workspace, or one still resolving its project. Inventing a
    // sentence here would be a second author for the one thing this design gives a single one.
    const { container } = renderPane(() => {})
    expect(screen.queryByTestId('app-pane-empty')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
  })
})

describe('one author for every pane sentence', () => {
  it('renders the map`s headline and detail verbatim', () => {
    renderPane((c) => c.workspace.set(reportFor(reading({ state: 'asleep', restorable: true }))))

    const empty = screen.getByTestId('app-pane-empty')
    expect(empty.textContent).toContain('Your app is saved.')
    expect(empty.textContent).toContain('It stays running while you work, so you only do this once.')
  })

  it('★ draws the board\'s mark above the headline on the three states that have one', () => {
    // `NothingBuilt`, `PreviewOff` and `PreviewStarting` each put a 30px #9AA5B1 glyph directly
    // above the headline, and it is the only thing that makes a blank half-screen read as a
    // deliberate state rather than as a page that failed to load. The card and the "YOUR APP"
    // label landed; its contents were still headline + sentence + button.
    const withGlyph: [string, PreviewState][] = [
      ['never-built', reading({ state: 'never_built', restorable: false })],
      ['not-running', reading({ state: 'asleep', restorable: true })],
      ['starting', reading({ state: 'starting' })],
    ]

    for (const [name, preview] of withGlyph) {
      const { unmount } = renderPane((c) => c.workspace.set(reportFor(preview)))
      const glyph = screen.getByTestId('app-pane-glyph')
      expect(screen.getByTestId('app-pane-empty').getAttribute('data-workspace-state'), name).toBe(name)
      expect(glyph.getAttribute('width')).toBe('30')
      // Decorative: the headline underneath already says it in words.
      expect(glyph.getAttribute('aria-hidden')).toBe('true')
      unmount()
    }
  })

  it('★ and draws none for a state no board has a mark for', () => {
    // Seven of the ten states are hand-overs, read failures and start outcomes that the canvas has
    // never drawn. Borrowing one of the three marks for them would be this file inventing the
    // design; saying nothing is the honest answer, and the sentence still carries the state.
    renderPane((c) => c.workspace.set(reportFor(reading({ state: 'unknown' }))))

    expect(screen.queryByTestId('app-pane-glyph')).toBeNull()
    // LIVENESS: the card is there and speaking, so this is a deliberate absence rather than a
    // pane that rendered nothing.
    expect(screen.getByTestId('app-pane-empty').textContent?.length).toBeGreaterThan(10)
  })

  it('never says what the app is NOT (R-16)', () => {
    for (const preview of [
      reading({ state: 'asleep', restorable: true }),
      reading({ state: 'never_built', restorable: false }),
      reading({ state: 'starting' }),
      reading({ state: 'unknown' }),
    ]) {
      const { unmount } = renderPane((c) => c.workspace.set(reportFor(preview)))
      const text = region().textContent ?? ''
      expect(text).not.toMatch(/not running/i)
      expect(text).not.toMatch(/\bstopped\b/i)
      expect(text).not.toMatch(/unavailable/i)
      // "preview" is the developer's word for the thing; the person's word is their app.
      expect(text).not.toMatch(/\bpreview\b/i)
      unmount()
    }
  })
})

/**
 * ★ THE THREE DEFECTS AN EARLIER CUT OF THIS FILE SHIPPED, all caught by the suites that pin the
 * surfaces around this one rather than by review.
 *
 * The shared cause was reading `address.url` as the whole seam. It is not: the resolver also
 * returns a STATUS, deliberately independent of the URL, and an address deliberately OUTLIVES its
 * publisher — so a URL alone is neither necessary nor sufficient evidence that something is
 * serving.
 */
describe('the seam is the address AND the state, not the URL alone', () => {
  it('★ frames the LOADING state — a status with no URL yet, which is a first build coming up', () => {
    // `previewAddress.ts` says it in its own docblock: "a build that is provisioning has a status
    // and no URL yet, and that pair is what renders the loading state instead of an empty pane."
    // Gating on the URL alone put "We could not check on your app." in front of a citizen watching
    // their first build.
    //
    // Mutation receipt: change the gate back to `address.url !== null` and this goes red.
    const { container } = renderPane((c) => {
      c.workspace.set(reportFor(null))
      c.address.set({ url: null, status: 'provisioning', serving: false, projectId: 'p1' })
      c.project.set('p1')
      c.visible.set(true)
      // A surface mid-build publishes its pane view; the host's own "nothing to host at all" early
      // return is about a project nobody has opened a conversation in, which is not this.
      c.pane.set(PANE_VIEW)
    })

    // The host is mounted — it is what draws the wait — and no sentence is drawn over it.
    expect(screen.queryByTestId('app-pane-empty')).toBeNull()
    expect(container.querySelector('[data-testid="app-pane"]')).toBeTruthy()
  })

  it('★ stops framing a HELD address once the workspace says nothing is serving', () => {
    // The address outlives its publisher — that is R8's mechanism — so a URL stays held after the
    // container behind it has stopped. Framing it regardless meant an app that went to sleep showed
    // a card saying "nothing is lost" with NO way to bring it back: R3's "exactly one control
    // starts it", satisfied by zero, in an entirely ordinary state.
    renderPane((c) => {
      c.workspace.set(reportFor(reading({ state: 'asleep', restorable: true })))
      c.address.set({ url: 'https://app.example/', status: 'ready', serving: true, projectId: 'p1' })
      c.project.set('p1')
      c.visible.set(true)
    })

    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('button', { name: /launch application/i })).toBeTruthy()
  })

  it('★ an UNKNOWN never pulls a framed app off the screen', () => {
    // The rule the whole preview reshape exists for: a read that decided nothing must not retire a
    // frame somebody is looking at. `could-not-read` is deliberately absent from the veto set.
    const { container } = renderPane((c) => {
      c.workspace.set(reportFor(reading({ state: 'unknown' })))
      c.address.set({ url: 'https://app.example/', status: 'ready', serving: true, projectId: 'p1' })
      c.project.set('p1')
      c.visible.set(true)
    })

    expect(container.querySelector('iframe')).toBeTruthy()
    expect(screen.queryByTestId('app-pane-empty')).toBeNull()
  })

  it('keeps framing while a start outcome describes a press, not a container', () => {
    // `not-painted` / `timed-out` / `start-failed` say a press did not land. If a frame is already
    // up, that frame is better evidence than the press was.
    const { container } = renderPane((c) => {
      c.workspace.set(reportFor(reading({ state: 'asleep' }), { kind: 'timed-out' }))
      c.address.set({ url: 'https://app.example/', status: 'ready', serving: true, projectId: 'p1' })
      c.project.set('p1')
      c.visible.set(true)
    })

    expect(container.querySelector('iframe')).toBeTruthy()
  })
})

describe('the column a plan chat does not get (plan 002, U6)', () => {
  // THE DEFECT THIS BLOCK IS WRITTEN AGAINST, found in a browser and not by any suite: `AppPane`
  // read the report and the address but never the VISIBILITY, so its `flex-1` section claimed half
  // the window on a plan chat — filled with the "Your app is saved / Launch Application" card,
  // offering to start an app the citizen had not asked about. `AppPaneHost` hides itself correctly,
  // but a plan chat never reaches it: with nothing to frame, `NoFrame` renders instead.
  //
  // The knock-on was the visible half of the bug. `ConversationSurface` centres a plan chat with
  // `mx-auto max-w-3xl`, which does nothing inside a rail that is only half the screen — so the
  // board's one centred column rendered as a left-aligned half-width one.

  // WHOLE CLASSES, NOT SUBSTRINGS. `min-w-0` contains `w-0`, so a `toContain` here passes on the
  // very layout this block exists to forbid.
  const paneClasses = (container: HTMLElement) =>
    (container.querySelector('[data-testid="app-pane-region"]')?.className ?? '').split(/\s+/)

  it('★ takes no width when no surface asks for the pane', () => {
    const { container } = renderPane((c) => {
      c.workspace.set(reportFor(reading()))
    }, false)

    expect(paneClasses(container)).toContain('w-0')
    expect(paneClasses(container)).not.toContain('flex-1')
  })

  it('★ zeroes its HEIGHT too, for the stacked layout below the threshold', () => {
    // Above the threshold this column sits in a flex row, where a zero width is enough. Below it
    // the same element is a child of a flex COLUMN, and a width of zero leaves a full-height band
    // of nothing under the rail — the stacked layout's version of the same bug.
    const { container } = renderPane((c) => {
      c.workspace.set(reportFor(reading()))
    }, false)

    expect(paneClasses(container)).toContain('h-0')
  })

  it('★ leaves the accessibility tree, so nothing in it is reachable by keyboard', () => {
    // `visibility:hidden` is the mechanism and jsdom loads no stylesheet, so the `aria-hidden`
    // beside it is what this assertion can see — and it is the half that a screen reader obeys.
    // Without it the skip control and any start button stay announced on a screen that draws none.
    renderPane((c) => c.workspace.set(reportFor(reading())), false)

    expect(screen.getByTestId('app-pane-region').getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('button', { name: /skip past your app/i })).toBeNull()
  })

  it('is HIDDEN, never unmounted — a running app survives the move to a plan chat', () => {
    // The reason the pane is a sibling of the outlet at all. Unmounting re-issues the frame's
    // `src` on the way back, which is a full reload of somebody's application.
    const { container } = renderPane((c) => {
      c.workspace.set(reportFor(reading({ state: 'alive', alive: true })))
      c.address.set({ url: 'https://app.example/', status: 'ready', serving: true, projectId: 'p1' })
      c.project.set('p1')
      c.pane.set(PANE_VIEW)
    }, false)

    expect(container.querySelector('iframe')).toBeTruthy()
    expect(screen.getByTestId('app-pane-region').className).toContain('invisible')
  })

  it('takes the width back the moment a surface asks for it', () => {
    const { container } = renderPane((c) => c.workspace.set(reportFor(reading())), true)

    expect(paneClasses(container)).toContain('flex-1')
    expect(paneClasses(container)).not.toContain('w-0')
  })
})

describe('the movement between the two layouts (plan 002, U6)', () => {
  const paneClasses = (container: HTMLElement) =>
    (container.querySelector('[data-testid="app-pane-region"]')?.className ?? '').split(/\s+/)

  /** A build chat with a running app framed: the state a citizen actually leaves FROM. */
  const framed = (c: WorkspaceChannel) => {
    c.workspace.set(reportFor(reading({ state: 'alive', alive: true })))
    c.address.set({ url: 'https://app.example/', status: 'ready', serving: true, projectId: 'p1' })
    c.project.set('p1')
    c.pane.set(PANE_VIEW)
  }

  it('★ slides out at full width and only then collapses', async () => {
    // `T2Sliding` is a whole artboard of this one moment — "the app card is sliding out to the
    // right and fading as it goes … a moment later the app is gone" — and until now the keyframe
    // existed, was suppressed under reduced motion, and was applied to nothing. Applying it to the
    // collapsed arm would have changed nothing either: an element at `w-0 invisible` cannot be
    // watched fading, which is why the column holds its size for the length of the animation.
    const { container, channel } = renderPane(framed, true)
    expect(paneClasses(container)).not.toContain('animate-pane-leave')

    act(() => channel.visible.set(false))

    expect(paneClasses(container)).toContain('animate-pane-leave')
    expect(paneClasses(container)).toContain('flex-1')
    expect(paneClasses(container)).not.toContain('w-0')
    // Gone to a reader immediately, even while it is still on screen for the eye.
    expect(screen.getByTestId('app-pane-region').getAttribute('aria-hidden')).toBe('true')

    await waitFor(() => expect(paneClasses(container)).toContain('w-0'))
    expect(paneClasses(container)).not.toContain('animate-pane-leave')
    // AND THE APP WAS NEVER TOUCHED BY ANY OF IT — "nothing about the app is stopped or reloaded,
    // it is only taken off the screen." This is also the liveness half: every class assertion
    // above would pass just as happily against a host that unmounted the frame.
    expect(container.querySelector('iframe')).toBeTruthy()
  })

  it('★ stays out of the keyboard’s reach for the WHOLE leave, not only once it has gone', async () => {
    // THE GAP THIS IS WRITTEN AGAINST. The column holds its size for the length of the animation so
    // the card can be watched leaving, which means `visibility:hidden` — the thing that takes a
    // subtree out of the tab order — cannot land yet. For those 240ms the pane was announced as
    // gone and still one Tab away: a keyboard could land on the skip control, or inside the frame
    // of an app that was no longer on the screen. `hiddenSubtree.ts` names that pairing a WCAG
    // 4.1.2 violation, and this is the applier where what is hidden is a whole application.
    //
    // ASSERTED AS THE ATTRIBUTE, and honestly: jsdom implements no part of `inert` — it neither
    // reflects the property nor refuses a `focus()` inside one — so a focus simulation here would
    // be inventing a browser rather than testing one. The attribute IS the mechanism a browser
    // obeys, which is the same bargain the `aria-hidden` assertions in this file already make.
    const { container, channel } = renderPane(framed, true)
    // A pane somebody is looking at is reachable, or the assertion below proves nothing.
    expect(region().hasAttribute('inert')).toBe(false)

    act(() => channel.visible.set(false))

    // MID-LEAVE: still sized, still animating, still framing the app — and unreachable.
    expect(paneClasses(container)).toContain('animate-pane-leave')
    expect(paneClasses(container)).not.toContain('invisible')
    expect(region().hasAttribute('inert')).toBe(true)
    // LIVENESS, and the reason a subtree attribute is the right shape: the two focusable things
    // inside the region are the skip control and the frame itself, and both are covered by one
    // attribute rather than by a list this test would have to keep up with.
    expect(container.querySelector('iframe')?.closest('[inert]')).toBe(region())
    expect(region().querySelector('button')?.textContent).toMatch(/skip past your app/i)

    // AND IT IS STILL UNREACHABLE ONCE THE HOLD ENDS, where `visibility:hidden` takes over.
    await waitFor(() => expect(paneClasses(container)).toContain('w-0'))
    expect(region().hasAttribute('inert')).toBe(true)
  })

  it('★ becomes reachable again the moment the pane is back', async () => {
    // The other direction, and the one that would turn this fix into a worse bug than the one it
    // fixes: an `inert` that never lifted would leave a citizen looking at their app unable to
    // reach anything in it, with nothing on the screen to explain why.
    const { container, channel } = renderPane(framed, true)

    act(() => channel.visible.set(false))
    await waitFor(() => expect(paneClasses(container)).toContain('w-0'))
    act(() => channel.visible.set(true))

    expect(region().hasAttribute('inert')).toBe(false)
    expect(container.querySelector('iframe')?.closest('[inert]')).toBeNull()
  })

  it('★ carries the return half of the pair when the pane comes back', async () => {
    const { container, channel } = renderPane(framed, true)
    expect(container.querySelector('[data-testid="app-pane"]')?.className).toMatch(/animate-pane-return/)

    act(() => channel.visible.set(false))
    await waitFor(() => expect(paneClasses(container)).toContain('w-0'))
    act(() => channel.visible.set(true))

    // The return interrupts a departure rather than queueing behind it.
    expect(paneClasses(container)).not.toContain('animate-pane-leave')
    expect(container.querySelector('[data-testid="app-pane"]')?.className).toMatch(/animate-pane-return/)
  })

  it('★ a pane that was never on screen does not animate its way to nothing', () => {
    // Every plan chat opened cold, and the project screen before anything is built. There is no
    // departure to draw, so there is no hold either — the column is at rest on its first frame.
    const { container } = renderPane(framed, false)

    expect(paneClasses(container)).toContain('w-0')
    expect(paneClasses(container)).not.toContain('animate-pane-leave')
  })

  it('★ both halves are suppressed for a reader who asked for less motion', () => {
    // Asserted against the STYLESHEET because that is where the suppression lives, and jsdom
    // loads no stylesheet: nothing else in the suite would notice the media block being deleted.
    // A citizen sets this preference because motion makes them ill, so it is not decoration.
    // Resolved from the vitest root (`portal/`), not from `import.meta.url`: under vite the
    // module's own URL is not a `file:` one, so `new URL(…, import.meta.url)` cannot be read.
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced.length).toBeGreaterThan(0)

    // Each utility is looked up in whatever rule carries it, rather than in a rule matching the
    // two of them ADJACENT. The old regex demanded `.animate-pane-leave, .animate-pane-return {`
    // literally, so #210 — which suppressed the same way by adding `.animate-spin`,
    // `.animate-pulse` and `.animate-bounce` to this very selector list — turned this guard red
    // while the guarantee it protects was strictly widened. A guard that breaks when the thing it
    // guards gets stronger is a guard that gets deleted.
    for (const utility of ['animate-pane-leave', 'animate-pane-return']) {
      const rule = reduced.match(new RegExp(String.raw`([^{}]*\.${utility}\b[^{}]*)\{([^}]*)\}`))
      expect(rule, `no rule in the reduce-motion block names .${utility}`).not.toBeNull()
      expect(rule?.[2]).toMatch(/animation:\s*none/)
    }
    // LIVENESS: the two utilities the block suppresses are the two the components apply, so the
    // rule cannot go on matching class names nothing renders.
    const column = readFileSync(resolve(process.cwd(), 'src/components/workspace/AppPane.tsx'), 'utf8')
    const host = readFileSync(resolve(process.cwd(), 'src/components/workspace/AppPaneHost.tsx'), 'utf8')
    expect(column).toContain('animate-pane-leave')
    expect(host).toContain('animate-pane-return')
  })
})

/**
 * ★ A BLOCKED PROJECT TAKES ITS WORKSPACE BACK (`#196`, U13) — the pane half.
 *
 * ═══ WHAT THIS BLOCK IS WRITTEN AGAINST ═══
 *
 * The unit's three structural traps, each of which passes review and fails in a browser:
 *
 *  1. A take-back that reports `onStartPending` UNMOUNTS ITS OWN BUTTON. `resolveWorkspaceState`
 *     answers `gettingReady()` on an in-flight press, that arm offers no action, and `NoFrame`
 *     draws a control only where there is one. The pane also stops framing on `starting`. So the
 *     in-flight assertions below assert the ARM as well as the button, because "the buttons are
 *     still there" and "the pane is still held" are two different failures.
 *  2. THE DIALOG OWNS `busy` AND `error` ITSELF, and its `run()` catches every rejection into one
 *     alert while staying mounted. If the take-back's handlers rejected, that alert would be what
 *     a citizen reads on all five of D2's endings and none of the pane states below would be
 *     reachable. Every failing ending here asserts the dialog is GONE.
 *  3. THE REOPENED DIALOG IS A NEW MOUNT. It takes focus in a mount-time effect, so a dialog
 *     updated in place would leave a keyboard user parked where the busy state put them while the
 *     copy in front of them started naming a different project.
 */
describe('★ taking the workspace back (#196)', () => {
  const HELD: Partial<PreviewState> = {
    state: 'slot_taken', occupyingProjectName: 'Car pool', occupyingProjectId: 'pA', restorable: true,
  }

  /** The refusal `POST /relaunch` raises when another project holds the one workspace. */
  const blocked = (over: Record<string, unknown> = {}) =>
    new ApiError('“Car pool” is still open.', 409, 'sandbox_reclaim_blocked', {
      projectId: 'pA', projectName: 'Car pool', dirty: true, building: false, ...over,
    })

  /** A promise a test opens and closes by hand, for asserting on the middle of a sequence. */
  function deferred<T>() {
    let settle!: (value: T) => void
    let fail!: (err: unknown) => void
    const promise = new Promise<T>((res, rej) => { settle = res; fail = rej })
    return { promise, settle, fail }
  }

  /**
   * The pane, held by another project, with the report's handlers exposed as spies.
   *
   * `onStartPending` IS WIRED TO THE MAP, exactly as both real publishers wire it — the project
   * hook's `reportStartPending` and the chat surface's `setStartPending` both feed
   * `resolveWorkspaceState`. Without that the arm assertion below would be vacuous: a harness
   * holding one frozen state cannot show a take-back unmounting its own button, which is the
   * precise failure D2 describes.
   */
  function heldPane(startOutcome: StartOutcome | null = null) {
    const channel = createWorkspaceChannel()
    const report: WorkspaceReport = {
      ...reportFor(reading(HELD), startOutcome),
      onStartPending: vi.fn((pending: boolean) => {
        act(() => channel.workspace.set({ ...report, state: reportFor(reading(HELD), startOutcome, pending).state }))
      }),
    }
    channel.visible.set(true)
    channel.workspace.set(report)
    const rendered = render(
      <MemoryRouter>
        <div id={WORKSPACE_RAIL_ID} />
        <WorkspaceChannelProvider value={channel}>
          <AppPane device="Desktop" reloadNonce={0} />
        </WorkspaceChannelProvider>
      </MemoryRouter>,
    )
    return { ...rendered, report, channel }
  }

  const takeBack = () => screen.getByRole('button', { name: /^Stop “Car pool” and open this app instead$/ })
  const openHolder = () => screen.getByRole('button', { name: /^Open “Car pool”$/ })
  const dialog = () => screen.queryByRole('dialog')

  /**
   * Press the take-back and wait for the server's refusal to raise the question.
   *
   * ONLY THE FIRST ANSWER IS SCRIPTED HERE — `mockRejectedValueOnce` queues ahead of whatever base
   * answer the test has set, so the SECOND relaunch (the one that closes the sequence) is the
   * caller's to choose. `beforeEach` makes that a successful start unless a test says otherwise.
   */
  async function askTheQuestion(over: Record<string, unknown> = {}) {
    api.relaunchPreview.mockRejectedValueOnce(blocked(over))
    const pane = heldPane()
    fireEvent.click(takeBack())
    await screen.findByRole('dialog')
    return pane
  }

  it('★ the held arm draws TWO controls, and the first is untouched', async () => {
    heldPane()
    // Unchanged in label and in behaviour, per the owner's decision on #196.
    expect(openHolder()).toBeTruthy()
    expect(takeBack()).toBeTruthy()
  })

  it('the unattributed arm still draws neither', () => {
    renderPane((c) => c.workspace.set(reportFor(reading({ state: 'slot_taken' }))))
    expect(screen.queryByRole('button', { name: /^Stop|^Open /i })).toBeNull()
    // LIVENESS: it is still speaking, so this is a withheld pair rather than an empty card.
    expect(screen.getByTestId('app-pane-empty').textContent?.length).toBeGreaterThan(10)
  })

  it('★ pressing it asks THIS project`s own start, and the server`s refusal is what opens the dialog', async () => {
    const { report } = await askTheQuestion()

    expect(api.relaunchPreview).toHaveBeenCalledWith({ projectId: 'p1' })
    // And the question leads with what the citizen is trying to do, not with the obstacle.
    expect(dialog()?.textContent).toContain('Car pool')
    // ★ TRAP 1. The whole point of not routing this through the in-flight channel.
    expect(report.onStartPending).not.toHaveBeenCalled()
  })

  for (const [dirty, expected, forbidden] of [
    [true, /has changes that are not saved yet/i, null],
    [false, /Everything saved in “Car pool” stays exactly as it is/i, /unsaved|not saved yet/i],
    [null, /may have changes that are not saved yet/i, null],
  ] as const) {
    it(`reaches the dialog's ${String(dirty)} copy arm — from the refusal, which is the only place that answer exists`, async () => {
      await askTheQuestion({ dirty })
      expect(dialog()?.textContent).toMatch(expected)
      if (forbidden) expect(dialog()?.textContent).not.toMatch(forbidden)
      // The clean arm offers no Save button for work that does not exist.
      const save = screen.queryByRole('button', { name: /^Save “Car pool” and stop it$/ })
      expect(save === null).toBe(dirty === false)
    })
  }

  for (const [name, button, save] of [
    ['saving first', /^Save “Car pool” and stop it$/, true],
    ['without saving', /^Stop “Car pool” without saving$/, false],
  ] as const) {
    it(`★ confirming ${name} stops the holder and brings this app up — one press, no turn`, async () => {
      const { report } = await askTheQuestion()

      fireEvent.click(screen.getByRole('button', { name: button }))

      await waitFor(() => expect(api.handOverWorkspace).toHaveBeenCalledWith('pA', save, {}, expect.any(Function)))
      // The relaunch that closes the sequence, and the URL the pane frames.
      await waitFor(() => expect(api.relaunchPreview).toHaveBeenCalledTimes(2))
      expect(report.onStarted).toHaveBeenCalledWith('https://app/')
      expect(report.onStartOutcome).toHaveBeenCalledWith(null)
      // ★ TRAP 1 again, on the path that actually starts an app: the pane must never be told a
      // start is pending, or it un-frames itself and unmounts the control mid-sequence.
      expect(report.onStartPending).not.toHaveBeenCalled()
      await waitFor(() => expect(dialog()).toBeNull())
    })
  }

  it('★ ENDING 1 — a stop that failed dismisses the dialog and hands the pane the server`s sentence', async () => {
    // `buildSessionApi.ts` authors the two-minute ceiling sentence. It arrives here verbatim, and
    // `stoppedHolder` is null because nothing was stopped.
    const ceiling = 'The other app is still saving its work. Nothing has changed — give it a moment and try again.'
    api.handOverWorkspace.mockImplementation(async (_id, _save, _deps, narrate: (s: HandoverStep) => void) => {
      narrate('stopping')
      throw new ApiError(ceiling, 409, 'stop_did_not_settle')
    })
    const { report } = await askTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: /^Stop “Car pool” without saving$/ }))

    await waitFor(() =>
      expect(report.onStartOutcome).toHaveBeenCalledWith({
        kind: 'take-back-failed', reason: ceiling, stoppedHolder: null,
      }),
    )
    // ★ TRAP 2. The pane is the single reporting surface, so the dialog is gone and its own
    // "That did not work. Please try again." alert never appeared.
    await waitFor(() => expect(dialog()).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
    // LIVENESS: the pane is still on the held arm with both ways out, which is where D2 puts it.
    expect(screen.getByTestId('app-pane-empty').getAttribute('data-workspace-state')).toBe('held-by-another-project')
    expect(takeBack()).toBeTruthy()
  })

  for (const [ending, at, reason] of [
    ['ENDING 3 — the save failed', 'saving', 'Could not save your work'],
    ['ENDING 4 — the release failed', 'releasing', 'Could not close the other workspace'],
  ] as const) {
    it(`★ ${ending}: the holder is down, and the outcome says so`, async () => {
      api.handOverWorkspace.mockImplementation(async (_id, _save, _deps, narrate: (s: HandoverStep) => void) => {
        narrate('stopping')
        if (at === 'releasing') narrate('saving')
        narrate(at)
        throw new ApiError(reason, 500)
      })
      const { report } = await askTheQuestion()

      fireEvent.click(screen.getByRole('button', { name: /^Save “Car pool” and stop it$/ }))

      await waitFor(() =>
        expect(report.onStartOutcome).toHaveBeenCalledWith({
          kind: 'take-back-failed', reason, stoppedHolder: 'Car pool',
        }),
      )
      await waitFor(() => expect(dialog()).toBeNull())
      expect(screen.queryByRole('alert')).toBeNull()
    })
  }

  it('★ ENDING 2 — the slot was freed and the start failed: the outcome carries the stopped holder', async () => {
    api.relaunchPreview.mockRejectedValue(new ApiError('the image could not be pulled', 503))
    const pane = await askTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: /^Stop “Car pool” without saving$/ }))

    await waitFor(() =>
      expect(pane.report.onStartOutcome).toHaveBeenCalledWith({
        kind: 'take-back-failed', reason: 'the image could not be pulled', stoppedHolder: 'Car pool',
      }),
    )
    // The reading is stale the moment the release lands, so the pane asks again — without which it
    // would sit on a hand-over that is over instead of reaching `start-failed`.
    expect(pane.report.onRefresh).toHaveBeenCalled()
    await waitFor(() => expect(dialog()).toBeNull())

    // And that outcome, over the reading that follows it, is the pane D2 describes: the ordinary
    // failed-to-start sentence, one line naming the holder, and the same Try again.
    cleanup()
    renderPane((c) =>
      c.workspace.set(
        reportFor(reading({ state: 'asleep', restorable: true }), {
          kind: 'take-back-failed', reason: 'the image could not be pulled', stoppedHolder: 'Car pool',
        }),
      ),
    )
    expect(screen.getByTestId('app-pane-empty').getAttribute('data-workspace-state')).toBe('start-failed')
    expect(screen.getByTestId('app-pane-note').textContent).toBe('“Car pool” was stopped.')
    expect(screen.getByRole('button', { name: /^Try again$/ })).toBeTruthy()
  })

  it('★ ENDING 5 — another tab takes the freed slot: the question reopens, remounted, and takes focus', async () => {
    api.relaunchPreview.mockRejectedValue(blocked({ projectId: 'pB', projectName: 'Roster' }))
    const { report } = await askTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: /^Stop “Car pool” without saving$/ }))

    // The choice screen again, with new data — never the dialog's generic caught-error alert.
    const reopened = await screen.findByRole('button', { name: /^Save “Roster” and stop it$/ })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(report.onStartOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'take-back-failed' }))
    // ★ TRAP 3. A NEW MOUNT, proved by where the focus is: the dialog takes it in a mount-time
    // effect, so an in-place update would have left it on the card the busy state parked it on
    // while the copy silently started naming another project. Drop the `key` and this goes red.
    await waitFor(() => expect(document.activeElement).toBe(reopened))
  })

  it('★ while it runs: both controls inert, the take-back busy and renamed, and the arm still HELD', async () => {
    const hold = deferred<void>()
    api.handOverWorkspace.mockImplementation(async (_id, _s, _d, narrate: (s: HandoverStep) => void) => {
      narrate('stopping')
      await hold.promise
    })
    await askTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: /^Stop “Car pool” without saving$/ }))
    // The dialog is up and narrating; the pane behind it is what these assertions are about.
    await screen.findByTestId('reclaim-step')

    const working = screen.getByRole('button', { name: /^Taking your workspace back…$/ })
    expect(working.getAttribute('aria-busy')).toBe('true')
    expect(working.getAttribute('aria-disabled')).toBe('true')
    // BOTH, which is a fact about a pair of siblings and so cannot live in either of them.
    expect(openHolder().getAttribute('aria-disabled')).toBe('true')
    // ★ TRAP 1, asserted as the ARM rather than as the button — that is the failure D2 describes:
    // a take-back on the in-flight channel reaches `starting`, which offers no action at all and
    // un-frames the pane. The harness feeds `onStartPending` back through the map (see `heldPane`),
    // so reporting one here really does move this arm.
    expect(screen.getByTestId('app-pane-empty').getAttribute('data-workspace-state')).toBe('held-by-another-project')

    await act(async () => { hold.settle(); await Promise.resolve() })
  })

  it('the pane itself is a polite region, mounted before it has anything to say and on arms with no buttons', () => {
    // ★ CORRECTED (U8, `#197`). This asserted the region was `takeBack().parentElement` — the ROW
    // THE TWO CONTROLS SIT IN — which was true and was the defect: the region lived inside the
    // block that renders the buttons, so any state with `action: null` had no live region at all.
    // `starting` is exactly such a state, and it is the one wait in the product with nothing to
    // press, so a sandbox start announced NOTHING. What this test now rejects is a region scoped
    // to the controls rather than to the pane.
    //
    // #210's rule still holds and is why the region exists here at all: `LivePreview` keeps the
    // pane's other permanent region and is not mounted on these arms, so without this one the
    // wait would pass in silence. Never a second `sr-only` copy of a sentence already on screen —
    // the two regions divide the pane, and this one owns the states with no app in them.
    heldPane()
    const region = screen.getByTestId('app-pane-live')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    // It is the pane, not the controls: the take-back row is INSIDE it rather than being it.
    expect(region.contains(takeBack())).toBe(true)
    expect(takeBack().parentElement?.getAttribute('role')).not.toBe('status')

    // ★ THE ARM THE MOVE WAS FOR. `starting` offers no action, so under the old scoping it had no
    // region on any screen. Asserted with liveness — the board really rendered — so a pane that
    // failed to mount cannot pass by having no region either.
    cleanup()
    renderPane((c) => c.workspace.set(reportFor(reading({ state: 'starting' }))))
    expect(screen.getByTestId('app-pane-empty').getAttribute('data-workspace-state')).toBe('starting')
    const starting = screen.getByTestId('app-pane-live')
    expect(starting.getAttribute('role')).toBe('status')
    expect(starting.getAttribute('aria-live')).toBe('polite')
  })

  it('★ unmounting mid-sequence updates nothing and crashes nothing — and the server sequence finishes', async () => {
    // The citizen clicks another project during the up-to-two-minute stop wait. The existing
    // hand-over never needed this: its last act is a navigate that unmounts the surface anyway.
    const hold = deferred<void>()
    api.handOverWorkspace.mockImplementation(async (_id, _s, _d, narrate: (s: HandoverStep) => void) => {
      narrate('stopping')
      await hold.promise
    })
    const errors: unknown[] = []
    const onError = (e: ErrorEvent) => errors.push(e.error)
    window.addEventListener('error', onError)
    const { unmount, report } = await askTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: /^Stop “Car pool” without saving$/ }))
    await screen.findByTestId('reclaim-step')
    unmount()

    await act(async () => { hold.settle(); await Promise.resolve() })
    // The rest of the sequence ran server-side regardless — the relaunch that closes it fired.
    await waitFor(() => expect(api.relaunchPreview).toHaveBeenCalledTimes(2))
    expect(errors).toEqual([])
    // The report outlives the pane and is still told, exactly as the start path's own note says.
    expect(report.onStarted).toHaveBeenCalledWith('https://app/')
    window.removeEventListener('error', onError)
  })

  it('cancelling changes nothing anywhere, and leaves both controls live', async () => {
    await askTheQuestion()

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))

    await waitFor(() => expect(dialog()).toBeNull())
    expect(api.handOverWorkspace).not.toHaveBeenCalled()
    expect(takeBack().getAttribute('aria-disabled')).toBe('false')
    expect(openHolder().getAttribute('aria-disabled')).toBe('false')
  })

  /**
   * ★ THE SEQUENCE IS OWNED BY A PROJECT, BECAUSE THE PANE OUTLIVES ONE.
   *
   * `AppPane` is a SIBLING of the Outlet in `WorkspaceShell`, never a child of it — that is the
   * whole reason leaving a build chat for the project screen does not reload the running app. The
   * cost is that a move from one project to another runs NO cleanup here: the same `useState`s
   * carry straight over, and until this fix nothing in `useTakeBack` named a project. A citizen who
   * opened the take-back on A and then went to B was left reading A's hand-over question over B's
   * pane, or holding B's control in a busy state belonging to A's sequence.
   *
   * BOTH TESTS PUBLISH B ONTO THE SAME CHANNEL AND NEVER RE-RENDER THE TREE, which is exactly what
   * the router does — a re-render with a new report and no unmount. Rendering a second pane would
   * test a remount, which is the one case that was never broken.
   */
  describe('★ moving to another project does not inherit this one`s take-back', () => {
    /** What the router publishes on arriving at another project — itself held, by someone else. */
    const arriveAtTheOtherProject = (channel: WorkspaceChannel) =>
      act(() =>
        channel.workspace.set({
          ...reportFor(
            reading({
              state: 'slot_taken',
              occupyingProjectName: 'Roster',
              occupyingProjectId: 'pB',
              restorable: true,
            }),
          ),
          projectId: 'p2',
        }),
      )

    const othersTakeBack = () => screen.getByRole('button', { name: /^Stop “Roster” and open this app instead$/ })
    const othersOpenHolder = () => screen.getByRole('button', { name: /^Open “Roster”$/ })

    it('★ the question does not follow the citizen — A`s dialog closes and B draws its own arm', async () => {
      const { channel } = await askTheQuestion()
      expect(dialog()).toBeTruthy()

      arriveAtTheOtherProject(channel)

      // A's question named A's holder and asked what to do with A's unsaved work. Standing over B
      // it is a modal about a project nobody is looking at, whose Save and Stop buttons act on a
      // container the citizen did not come here to touch.
      expect(dialog()).toBeNull()
      // LIVENESS. The absence above is a dialog that closed, not a pane that stopped rendering:
      // B really did arrive, on its own held arm, with both of its own ways out.
      expect(screen.getByTestId('app-pane-empty').getAttribute('data-workspace-state')).toBe(
        'held-by-another-project',
      )
      expect(othersTakeBack().getAttribute('aria-disabled')).toBe('false')
      expect(othersOpenHolder().getAttribute('aria-disabled')).toBe('false')
    })

    it('★ nor does the busy flag, and A`s sequence cannot write back into B', async () => {
      const hold = deferred<void>()
      api.handOverWorkspace.mockImplementation(async (_id, _s, _d, narrate: (s: HandoverStep) => void) => {
        narrate('stopping')
        await hold.promise
      })
      // The relaunch that CLOSES A's sequence is refused by a third project. Chosen deliberately:
      // it is the one ending that opens a dialog rather than reporting an outcome, so a sequence
      // that could still write would raise a question over B's pane naming a project B has never
      // heard of — the leak's worst shape.
      api.relaunchPreview.mockRejectedValue(blocked({ projectId: 'pC', projectName: 'Gate pass' }))
      const { channel } = await askTheQuestion()
      fireEvent.click(screen.getByRole('button', { name: /^Stop “Car pool” without saving$/ }))
      await screen.findByTestId('reclaim-step')

      arriveAtTheOtherProject(channel)

      // B's control is idle: it has not renamed itself to "Taking your workspace back…", it claims
      // no busy state, and it is pressable — as is its neighbour, which A's sequence had made inert.
      expect(othersTakeBack().getAttribute('aria-busy')).toBe('false')
      expect(othersTakeBack().getAttribute('aria-disabled')).toBe('false')
      expect(othersOpenHolder().getAttribute('aria-disabled')).toBe('false')
      expect(dialog()).toBeNull()

      // AND A'S SEQUENCE FINISHING CHANGES NONE OF IT. It still runs to the end server-side — the
      // relaunch that closes it fires, exactly as the unmount case above — but every state write
      // names the project it began under, so none of them lands on B.
      await act(async () => {
        hold.settle()
        await Promise.resolve()
      })
      await waitFor(() => expect(api.relaunchPreview).toHaveBeenCalledTimes(2))
      expect(dialog()).toBeNull()
      expect(othersTakeBack().getAttribute('aria-busy')).toBe('false')
      expect(othersTakeBack().getAttribute('aria-disabled')).toBe('false')
      // LIVENESS again, after the settle: still B's own held arm, still both of B's controls.
      expect(screen.getByTestId('app-pane-empty').getAttribute('data-workspace-state')).toBe(
        'held-by-another-project',
      )
    })
  })
})
