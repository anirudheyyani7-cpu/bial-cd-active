/**
 * ★ LivePreview AUTHORS NO WORKSPACE SENTENCE, AND THIS FILE IS WHERE THAT IS KEPT TRUE.
 *
 * WHAT THIS FILE USED TO BE. It drove the pane through four "gone" states — asleep, slot_taken,
 * never_built, unknown — and pinned a headline and a body for each: `GONE_TITLE` and `goneBody`,
 * four titles and six bodies, plus the `showUnavailable` and `showTerminal` cards that drew them.
 * Every one of those sentences already had an author. `workspace/workspaceState.ts` computes ONE
 * state for the whole workspace and `AppPane` draws it, so this component was the SECOND author of
 * every one — and two authors of one sentence is not a duplication, it is a contradiction waiting
 * for the composition nobody tested. On 2026-09-10 the composition arrived: "Your workspace is
 * asleep" was drawn over an app the map was at that moment calling up.
 *
 * ★ AND THE OLD TESTS WOULD NOT HAVE CAUGHT THE DELETION GOING WRONG. They pinned that copy against
 * this component IN ISOLATION, so every one of them stayed green through a deletion that left the
 * composed product with no sentence at all. This repo has that written down as a lesson —
 * assert-absence tests false-green — and it applies to a whole FILE just as it does to one
 * assertion. So the file is cut deliberately rather than trusted to fail, and what replaces it
 * asserts the two halves that are actually load-bearing now: that no workspace verdict is spoken
 * here, and that the covers which are NOT verdicts still render.
 *
 * THE OWNER CARVE-OUT, STATED BECAUSE IT IS THE EASIEST THING TO DELETE BY ACCIDENT. The
 * frame-stall card and the loading cover STAY. They are the only thing in the platform watching
 * the CITIZEN's own wire: the serving proof the `alive` reading now rests on is a loopback GET to
 * 127.0.0.1:3000 inside the container, while the browser reaches the same app through portal nginx
 * → a variable `proxy_pass` → the ACA FQDN, via a resolver with `valid=30s`. "The platform watched
 * it answer" and "this browser can fetch it" are two different facts, and these covers observe the
 * second. Every test below that asserts one of them asserts its PRESENCE — a test that would still
 * pass with the cover deleted is not doing its job.
 *
 * These tests drive the component through the SAME parser the browser uses (`fetchPreviewState`),
 * so a backend that stops sending `state`, or a parser that starts coercing it, fails here rather
 * than in production. The wire values themselves are pinned in
 * `backend/tests/api/v1/build_sessions/test_preview_state.py`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, cleanup, fireEvent, screen } from '@testing-library/react'
import LivePreview from '../LivePreview'
import { fetchPreviewState } from '../../utils/buildSessionApi'
import type { PreviewState } from '../../utils/buildSessionApi'

afterEach(cleanup)

const SANDBOX_URL = 'https://app-xyz.example.azurecontainerapps.io/'

/** Put a real server body through the real client parser — no hand-built props. */
async function asTheBrowserSeesIt(body: unknown): Promise<PreviewState> {
  const res = { ok: true, json: async () => body } as unknown as Response
  return await fetchPreviewState('proj-1', { fetchImpl: async () => res })
}

/**
 * Matches of `re` that a SIGHTED citizen can see — i.e. everything outside the permanent sr-only
 * live region. That region speaks in every state, so an unfiltered `getByText` here would be
 * satisfied by the announcement alone and prove nothing about the screen.
 */
function seenNotJustSaid(re: RegExp) {
  const spoken = screen.getByRole('status')
  return screen.getAllByText(re).filter((el) => !spoken.contains(el))
}

/**
 * The pane, wired from a parsed server verdict exactly as the host wires it.
 *
 * TWO PROPS ARE GONE FROM THIS HELPER and their absence is the change: `occupyingProjectName` and
 * `hasSavedBuild` existed only to fill in a sentence about the WORKSPACE ("Baggage Reconciliation
 * is using your build workspace", "your saved app is still there"), and the map owns every one of
 * those now. They are not accepted props any more, so a test reaching for one is a compile error
 * rather than a value going quietly nowhere.
 */
function paneFor(state: PreviewState, extra: Record<string, unknown> = {}) {
  return render(
    <LivePreview
      previewUrl={SANDBOX_URL}
      status="ended"
      serving
      previewState={state.state}
      {...extra}
    />,
  )
}

/** The four sentences this component used to write about somebody else's subject. */
const RETIRED_WORKSPACE_COPY = [
  /workspace is asleep/i,
  /nothing is lost/i,
  /another project has your workspace/i,
  /using your build workspace/i,
  /nothing has been built here yet/i,
  /preview unavailable/i,
  /no longer running/i,
  /could not check on your preview/i,
  /start fresh/i,
]

describe('★ this pane speaks for the FRAME, and for nothing else', () => {
  it.each(['asleep', 'slot_taken', 'never_built', 'unknown'] as const)(
    '★ writes no headline, no body and no button for a `%s` workspace',
    async (state) => {
      // Each of these used to pick a title and a body out of this file's own copy table. The map
      // says all four now, on a board `AppPane` draws — and this pane is not even mounted for
      // three of them, because the frame veto refuses every reading but `running`.
      const verdict = await asTheBrowserSeesIt({
        state,
        alive: false,
        previewUrl: null,
        restorable: true,
      })
      const { container } = paneFor(verdict)

      for (const retired of RETIRED_WORKSPACE_COPY) {
        expect(container.textContent ?? '', `${state} still says ${retired}`).not.toMatch(retired)
      }
      // ★ LIVENESS, AND IT IS THE WHOLE POINT OF PAIRING IT. Every assertion above passes just as
      // happily on a component that threw and rendered nothing at all — which is exactly the
      // false-green this repo has written down. The pane really mounted, really has its permanent
      // region, and really is framing the app it was handed.
      expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
      expect(container.querySelector('iframe')).toBeTruthy()
    },
  )

  it('★ and offers no start control under any of its retired labels', async () => {
    // `RelaunchAffordance` and its four render sites are gone. Exactly ONE control starts the app —
    // `workspace/StartAppControl.tsx`, drawn by `AppPane` from the one computed state, whose action
    // union contains no destructive verb. The four placeholder buttons said the same thing five
    // times over, each in the vocabulary the client replaced ("preview" is the developer's word).
    const verdict = await asTheBrowserSeesIt({ state: 'asleep', alive: false, restorable: true })
    const { container } = paneFor(verdict)

    for (const label of [/bring it back/i, /relaunch/i, /launch application/i, /try again/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    // LIVENESS: the pane rendered and framed. The affordance's new home is asserted where it
    // lives — `AppPane.test.tsx` pins that every no-frame state still offers a reachable way to
    // start the app, which is the half that would otherwise go missing silently.
    expect(container.querySelector('iframe')).toBeTruthy()
  })

  it('★ no `role="alert"` survives here at all — a workspace verdict is not this pane`s emergency', async () => {
    for (const state of ['asleep', 'slot_taken', 'never_built', 'unknown'] as const) {
      const verdict = await asTheBrowserSeesIt({ state, alive: false, restorable: true })
      const view = paneFor(verdict)
      expect(screen.queryByRole('alert'), state).toBeNull()
      // LIVENESS beside each absence, per this repo's own rule.
      expect(view.container.querySelector('iframe'), state).toBeTruthy()
      view.unmount()
    }
  })
})

describe('★ `starting` is the pane`s own last word on never framing a container that is not answering', () => {
  it('★ withholds the frame AND puts a visible wait in its place', async () => {
    // A container the platform is still bringing up answers 502 at its own edge, and the apps
    // router turns a 502 into the "This app isn't running right now" page. Framed, that page is
    // shown to a citizen whose app is being started for them — the opposite of the truth, told at
    // the one moment they are watching. It was reported from production as a black panel over a
    // running build, and measured again on 2026-09-10.
    //
    // IT SURVIVES THE VETO THAT MAKES IT UNREACHABLE, ON PURPOSE. `AppPane` mounts this component
    // if and only if the workspace reading is `running`, so a `starting` reading should never get
    // this far. "Should never" is exactly the claim that was true of those eight seconds, and this
    // refusal costs one boolean.
    const verdict = await asTheBrowserSeesIt({
      state: 'starting',
      alive: false,
      previewUrl: null,
      restorable: null,
    })
    expect(verdict.state).toBe('starting')

    const { container } = paneFor(verdict)

    // Mutation check: drop `starting` from `showFrame`'s guard and this goes red with an iframe.
    expect(container.querySelector('iframe')).toBeNull()
    // ★ TAKING THE FRAME AWAY IS ONLY HALF A STATE, and the first version of this shipped only
    // that half: frame withheld, nothing in its place, an EMPTY RECTANGLE with the sentence
    // reaching screen-reader users and nobody else. The liveness assertion has to be the VISIBLE
    // one, because the sr-only region is mounted permanently and speaks in every state — asserting
    // on it was true over a pane drawing literally nothing.
    //
    // Mutation check: drop `starting` from `showLoading` and this goes red.
    expect(seenNotJustSaid(/opening your app/i)).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toMatch(/opening your app/i)
  })

  it('★ and says nothing about the workspace while it waits', async () => {
    const verdict = await asTheBrowserSeesIt({ state: 'starting', alive: false, restorable: null })
    const { container } = paneFor(verdict, { serving: false })

    for (const retired of RETIRED_WORKSPACE_COPY) {
      expect(container.textContent ?? '').not.toMatch(retired)
    }
    // LIVENESS: the wait is on screen, so the silence above is a withheld verdict rather than a
    // pane that rendered nothing.
    expect(seenNotJustSaid(/opening your app/i)).toHaveLength(1)
  })
})

/**
 * ★ THE OWNER CARVE-OUT — the covers that are NOT verdicts, and that therefore STAY.
 *
 * Their rule is that they may describe the document in front of them and nothing else. A test in
 * this block that would still pass with its cover deleted is not doing its job, so every one of
 * them asserts the cover's PRESENCE, on screen, outside the sr-only region.
 */
describe('★ the frame-stall card and the loading cover STAY — they watch the citizen`s own wire', () => {
  it('★ the loading cover holds the screen from "no URL yet" to the framed document`s own load', () => {
    // It used to be destroyed the instant `previewUrl` arrived, which is precisely when the 5-7s
    // first-route compile begins: the spinner vanished and left an unlabelled blank white card at
    // the exact moment the citizen had been told their app was ready.
    const { container, rerender } = render(<LivePreview previewUrl={null} status="provisioning" />)
    expect(seenNotJustSaid(/setting up your sandbox/i)).toHaveLength(1)

    rerender(<LivePreview previewUrl={SANDBOX_URL} status="ready" />)
    // The URL arrived and the frame is mounted but has not painted — the third wait, which needs a
    // line of its own because "Building your app" is stale by then and silence is a blank card.
    expect(seenNotJustSaid(/opening your app/i)).toHaveLength(1)
    expect(container.querySelector('iframe')).toBeTruthy()
    // And the frame is MOUNTED but not revealed: an iframe that never mounts never loads, and
    // `load` is the only thing that reveals it.
    expect(container.querySelector('[data-testid="device-card"]')?.className).toMatch(/opacity-0/)

    fireEvent.load(container.querySelector('iframe') as HTMLIFrameElement)
    expect(screen.queryAllByText(/opening your app/i)).toHaveLength(0)
    expect(container.querySelector('[data-testid="device-card"]')?.className).toMatch(/opacity-100/)
  })

  it('★ the frame-stall card renders when the document never arrives, and says so in words', () => {
    // ★ THE CARD THIS BLOCK EXISTS FOR. It is bounded degradation, not a verdict: the frame stays
    // MOUNTED underneath, so a load that lands after the cap still wins and reveals — which is why
    // the sentence says "slow", never "dead". Unmounting the frame would make the timeout permanent
    // by construction, because the `load` it is waiting for could never arrive.
    vi.useFakeTimers()
    try {
      const { container } = render(<LivePreview previewUrl={SANDBOX_URL} status="ready" />)
      // Before the cap it is the ordinary wait, so the card below is a state change rather than
      // something that was always on screen.
      expect(seenNotJustSaid(/opening your app/i)).toHaveLength(1)
      expect(screen.queryAllByText(/taking longer than usual to open/i)).toHaveLength(0)

      act(() => { vi.advanceTimersByTime(20001) })

      expect(seenNotJustSaid(/taking longer than usual to open/i)).toHaveLength(1)
      expect(screen.getByRole('status').textContent).toMatch(/taking longer than usual to open/i)
      // THE COPY NAMES NO CONTROL THIS CARD DOES NOT HAVE — the one start control lives in
      // `AppPane`, and an instruction pointing at nothing is worse than no instruction.
      expect(seenNotJustSaid(/it will appear here the moment it loads/i)).toHaveLength(1)
      // ★ THE FRAME IS STILL THERE. This is the assertion that makes the card bounded degradation
      // rather than a fifth workspace verdict, and it is the one that would go red if somebody
      // "simplified" the card into a replacement for the frame.
      expect(container.querySelector('iframe')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ a load that lands AFTER the cap still wins — the card says slow, never dead', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<LivePreview previewUrl={SANDBOX_URL} status="ready" />)
      act(() => { vi.advanceTimersByTime(20001) })
      expect(seenNotJustSaid(/taking longer than usual to open/i)).toHaveLength(1)

      fireEvent.load(container.querySelector('iframe') as HTMLIFrameElement)

      expect(screen.queryAllByText(/taking longer than usual to open/i)).toHaveLength(0)
      expect(container.querySelector('[data-testid="device-card"]')?.className).toMatch(/opacity-100/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ the reconnecting cover renders, and it is NO LONGER CAPPED', () => {
    // THE BOUND MOVED TO THE SERVER RATHER THAN VANISHING. A 20-second cap used to collapse this
    // cover into the "preview unavailable" card — one of the four workspace verdicts this file has
    // stopped authoring — so an expiry now has nowhere honest to go: an empty rectangle says
    // nothing, and re-mounting the frame over a dev server that is genuinely down frames the apps
    // router's error page, which is the exact defect this change exists to end. A crash that never
    // recovers clears the SERVING STAMP on the server, the reading stops being `running`, and
    // `AppPane` unmounts this pane and draws the one card.
    vi.useFakeTimers()
    try {
      const { container } = render(
        <LivePreview previewUrl={SANDBOX_URL} status="ended" serving reconnecting previewState="alive" />,
      )
      expect(seenNotJustSaid(/reconnecting to your preview/i)).toHaveLength(1)

      act(() => { vi.advanceTimersByTime(120_000) })

      // STILL THE COVER, two minutes later. What this pane owes that citizen is not a verdict — it
      // is to keep saying, honestly, that it is still waiting.
      expect(seenNotJustSaid(/reconnecting to your preview/i)).toHaveLength(1)
      expect(container.textContent ?? '').not.toMatch(/preview unavailable/i)
      // And the dead frame is replaced rather than shown: the cover IS the pane while it is up.
      expect(container.querySelector('iframe')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ the compile cover still holds over a frame, and it describes the PAGE, not the workspace', () => {
    // IDLE_BUSY_TEXT used to read "Getting your app ready…", which is word for word the sentence
    // the workspace map says while nothing is serving, and IDLE_BROKEN_TEXT used to open "Your app
    // isn't running right now" — the same claim the apps router's own error page makes, told from
    // inside a pane that exists only because the app is up. Two authors, one sentence; on
    // 2026-09-10 the two of them contradicted each other on screen.
    const { container, rerender } = render(
      <LivePreview previewUrl={SANDBOX_URL} status="ready" serving compileState="building" turnRunning />,
    )
    expect(seenNotJustSaid(/putting the latest change together/i)).toHaveLength(1)

    rerender(<LivePreview previewUrl={SANDBOX_URL} status="ready" serving compileState="building" />)
    expect(seenNotJustSaid(/putting this page together/i)).toHaveLength(1)
    expect(container.textContent ?? '').not.toMatch(/getting your app ready/i)

    rerender(<LivePreview previewUrl={SANDBOX_URL} status="ready" serving compileState="failed" />)
    expect(seenNotJustSaid(/this page can’t open/i)).toHaveLength(1)
    expect(container.textContent ?? '').not.toMatch(/isn’t running/i)
    // LIVENESS across all three: the frame is under the cover the whole time, which is what makes
    // these covers rather than states.
    expect(container.querySelector('iframe')).toBeTruthy()
  })
})

describe('LivePreview — one persistent status region announces every state', () => {
  it('the region is mounted even when the pane has nothing to say', () => {
    // Mounted ALWAYS, on purpose: inserting a live region together with its text announces
    // inconsistently, so the element outlives every state and only its text changes.
    //
    // Mutation-check: gate the region on `announcement` being non-empty and this goes red.
    const { container } = render(<LivePreview previewUrl={null} status={null} />)
    const region = container.querySelector('[role="status"]')
    expect(region).toBeTruthy()
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(region?.textContent).toBe('')
  })

  it('routes a RESTORE through the labelled wait, announced — not through a terminal card', () => {
    // "Behind a labelled wait, and at no point is an error shown," RE-POINTED. The wait it
    // used to drive was `showRestoring`, keyed off a `relaunching` prop nothing could set. The
    // restore a citizen can actually run comes back as a `previewUrl`, and the wait that labels it
    // is the frame's own load gate.
    const { container } = render(<LivePreview previewUrl={SANDBOX_URL} status="ready" />)

    expect(seenNotJustSaid(/opening your app/i)).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toMatch(/opening your app/i)
    expect(container.querySelector('[data-testid="preview-ended-card"]')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('★ falls SILENT once the frame reveals with no verdict — nothing checked the app', () => {
    // This asserted `/preview is live/i`, which the pane published from the framed document's
    // `load` alone: an event that fires for a 500 exactly as it does for a 200 on a frame whose
    // status code this pane cannot read. The wait ENDING is real and still asserted; what is no
    // longer asserted is a verdict nothing had evidence for.
    const { container } = render(
      <LivePreview previewUrl={SANDBOX_URL} status="ended" serving previewState="alive" />,
    )
    expect(screen.getByRole('status').textContent).toMatch(/opening your app/i)

    fireEvent.load(container.querySelector('iframe') as HTMLIFrameElement)

    expect(screen.getByRole('status').textContent).toBe('')
    // LIVENESS, PAIRED: the frame is up and revealed, so the silence is the announcement chain
    // reaching its end rather than a pane that failed to render.
    expect(container.querySelector('[data-testid="device-card"]')?.className).toMatch(/opacity-100/)
  })

  /**
   * The other half of the false "preview is live" claim, and why it was not simply deleted.
   *
   * Removing it outright left the SUCCESS path silent while the failure path spoke: a citizen
   * using a screen reader heard the wait end and then nothing, and could not tell "it worked"
   * from "the pane stopped talking". The failure verdict gets a sentence, so its opposite does
   * too — but only where there is evidence, which is a serving container AND a clean compile
   * verdict, never the framed document's `load`.
   */
  it('says the preview is live once the build is verified clean, and only then', () => {
    const view = render(
      <LivePreview previewUrl={SANDBOX_URL} status="ended" serving previewState="alive" compileState="clean" />,
    )
    fireEvent.load(view.container.querySelector('iframe') as HTMLIFrameElement)
    expect(screen.getByRole('status').textContent).toMatch(/preview is live/i)

    // ★ THE MUTANT THIS KILLS: `compileState !== 'failed'` instead of `=== 'clean'`. That is the
    // three-into-two collapse this exact-match check forbids, and it republishes the same false
    // claim on exactly the reload where nothing has been verified. An unreadable verdict must
    // assert NOTHING.
    view.rerender(
      <LivePreview previewUrl={SANDBOX_URL} status="ended" serving previewState="alive" compileState="unknown" />,
    )
    expect(screen.getByRole('status').textContent).toBe('')
    // LIVENESS, PAIRED: the pane is still framing the app, so the silence above is the rule
    // firing rather than a component that stopped rendering.
    expect(view.container.querySelector('iframe')).not.toBeNull()

    // And a container that is not answering cannot be called live however clean the build was.
    view.rerender(
      <LivePreview previewUrl={SANDBOX_URL} status="ended" serving={false} previewState="alive" compileState="clean" />,
    )
    expect(screen.getByRole('status').textContent).not.toMatch(/preview is live/i)
  })

  it('★ and that claim is held up by `AppPane``s VETO, not by this pane`s own inputs', () => {
    // ★ WRITTEN DOWN BECAUSE IT IS LOAD-BEARING AND INVISIBLE, and because the tempting version of
    // this claim is false. It is NOT true that the serving stamp reaches every input of the live
    // sentence: `serving` has three arms (`utils/previewAddress.ts`) and only `fromProject`
    // consults the preview-state poll — `fromTurn` and `fromSession` are a live turn's own word for
    // it and never see the stamp. So this component, handed a turn-sourced `serving` and a clean
    // compile, will announce the app live over a workspace reading that is nowhere near `running`.
    //
    // That is exactly what this test shows, and it is not a bug HERE: the sentence is honest in
    // the product because `AppPane` will not mount this component at all unless the reading is
    // `running`. Weaken that veto and the claim goes back to being unearned on the turn-sourced
    // arms, with nothing in this file to catch it — which is why the veto has its own exhaustive
    // test in `workspace/__tests__/AppPane.test.tsx` and why this one points at it.
    const view = render(
      <LivePreview previewUrl={SANDBOX_URL} status="ended" serving previewState="asleep" compileState="clean" />,
    )
    fireEvent.load(view.container.querySelector('iframe') as HTMLIFrameElement)

    expect(screen.getByRole('status').textContent).toMatch(/preview is live/i)
    // …over a reading the workspace map calls SAVED. One level up is where that is refused.
    expect(view.container.querySelector('iframe')).toBeTruthy()
  })
})

// The retraction, on the surface the citizen is actually looking at.
describe('a workspace found reverted while the tab sat idle', () => {
  // ★ IT OUTRANKS EVERY OTHER COVER SENTENCE, running turn or not. It is the only one that is a
  // fact about what is IN THE FRAME rather than about a compile; the others all describe the
  // citizen's own app, mid-change. A progress line over a workspace that has been wiped is exactly
  // the false-progress claim this pane must never make.
  //
  // Mutation check: move `workspaceLost` below `turnRunning` in the cover's ternary and the
  // during-a-turn case goes red.
  it.each([
    ['idle', false],
    ['during a turn', true],
  ])('names what is in the frame and promises the restore (%s)', (_when, turnRunning) => {
    render(
      <LivePreview
        previewUrl="https://app.example.test/"
        status="ended"
        serving
        previewState="alive"
        compileState="clean"
        turnRunning={turnRunning}
        workspaceLost
      />,
    )

    // TWO NODES, DELIBERATELY: the visible cover and the pane's permanent live region, which
    // announces the same sentence. `getAllBy` rather than `getBy` for that reason — and asserting
    // on BOTH is the point, because a cover nobody hears is half the retraction.
    expect(screen.getAllByText(/isn’t your app any more/i)).toHaveLength(2)
    // IT PROMISES A RESTORE, and unlike every other sentence in this component it is entitled to:
    // the next turn's integrity gate puts the app back from the last durable copy.
    expect(screen.getAllByText(/we’ll restore it/i).length).toBeGreaterThan(0)
    // ★ AND IT NAMES THE FRAME, NOT THE WORKSPACE. This sentence used to open "Your app stopped
    // running" — a verdict on the workspace that this component cannot reach and that contradicts
    // its own mounting condition.
    expect(screen.queryByText(/stopped running/i)).toBeNull()
  })

  it('leaves the ordinary idle wording alone when the workspace is fine', () => {
    render(
      <LivePreview
        previewUrl="https://app.example.test/"
        status="ended"
        serving
        previewState="alive"
        compileState="building"
      />,
    )

    expect(screen.queryByText(/isn’t your app any more/i)).toBeNull()
    // LIVENESS: the cover really is up, so the absence above is a choice of wording rather than
    // a component that rendered nothing at all.
    expect(screen.getAllByText(/putting this page together/i).length).toBeGreaterThan(0)
  })
})

describe('the wire parser — where a coercion would do its damage silently', () => {
  it('a missing `restorable` field parses to null, not to false', async () => {
    const verdict = await asTheBrowserSeesIt({ state: 'asleep', alive: false })
    expect(verdict.restorable).toBeNull()
  })

  it('an unreadable body is `unknown`, never a confident "gone"', async () => {
    const verdict = await asTheBrowserSeesIt('not json at all')
    expect(verdict.state).toBe('unknown')
    expect(verdict.alive).toBe(false)
    expect(verdict.restorable).toBeNull()
  })

  it('an unrecognised state falls back only as far as `alive` can prove', async () => {
    // A tab that outlives a deploy. `alive: true` is still a fact; anything else is unknown —
    // never a confident "gone", which is what the old parser would have produced.
    expect((await asTheBrowserSeesIt({ alive: true, previewUrl: SANDBOX_URL })).state).toBe('alive')
    expect((await asTheBrowserSeesIt({ alive: false, state: 'gone-ish' })).state).toBe('unknown')
  })

  it('STARTING parses as its own state, not a coerced "unknown"', async () => {
    // The closed-list defect this state exists to catch: an unwidened `PREVIEW_LIFE_STATES` would
    // fall through `asPreviewLifeState`'s fallback straight to 'unknown' (`alive` is false), which
    // is a confident-sounding "nothing to report" for a fact the server DID report.
    expect((await asTheBrowserSeesIt({ state: 'starting', alive: false })).state).toBe('starting')
  })
})

describe('★ the deletions, pinned structurally — because a rendered assertion cannot see them', () => {
  it('defines and exports no start affordance at all', async () => {
    // A STRUCTURAL guard, because the behavioural ones above can only see the states they set up.
    // Four render sites shared one component; deleting three and leaving the fourth is exactly the
    // partial removal that made this worth pinning, and no rendered assertion would have caught it.
    const source = (await import('../LivePreview?raw')).default as string
    const uses = source.split('RelaunchAffordance').length - 1

    // One mention survives — the note recording the removal and where the control went.
    expect(uses).toBe(1)
    expect(source).toMatch(/`RelaunchAffordance` IS GONE/)
    expect(source).not.toMatch(/function RelaunchAffordance/)
  })

  it('★ defines no workspace copy table, and no card to draw one from', async () => {
    // ★ THE PIN THE FILE-LEVEL DELETION NEEDED. The four titles and six bodies lived in
    // `GONE_TITLE` and `goneBody`, drawn by `showUnavailable` and `showTerminal`. A test that only
    // rendered the component would go green the moment those were deleted AND the moment somebody
    // reintroduced one under a new name behind a state this suite does not set up — so the
    // identifiers themselves are what is pinned.
    const source = (await import('../LivePreview?raw')).default as string

    // ASSERTED AS DEFINITIONS AND RENDER SITES, NOT AS MENTIONS, and the distinction is what keeps
    // this guard from fighting the documentation: the file's own docblock NAMES all four of these
    // while recording that they went, and a `not.toContain` would make writing that note down the
    // failure. What must not come back is a binding or a test hook, so that is what is matched.
    const cannotComeBack: [string, RegExp][] = [
      ['the copy table', /\b(const|let|function)\s+GONE_TITLE\b/],
      ['the body picker', /\b(const|let|function)\s+goneBody\b/],
      ['the unavailable card', /\b(const|let)\s+showUnavailable\s*=/],
      ['the terminal card', /\b(const|let)\s+showTerminal\s*=/],
      ['the unavailable card`s test hook', /preview-unavailable-card/],
      ['the terminal card`s test hook', /preview-ended-card/],
    ]
    for (const [what, definition] of cannotComeBack) {
      expect(source, `${what} is back in LivePreview.tsx`).not.toMatch(definition)
    }
    // AND THE FILE SAYS WHY, so the next person to reach for a workspace sentence here reads the
    // rule before they write one.
    expect(source).toMatch(/THIS FILE NO LONGER AUTHORS A SINGLE WORKSPACE SENTENCE/)
    // LIVENESS: the source really was read, so a bad import path cannot green the sweep above.
    expect(source).toMatch(/export default function LivePreview/)
  })

  it('★ accepts no prop whose only job was filling in a workspace sentence', async () => {
    // `hasSavedBuild` and `occupyingProjectName` went with the two cards that read them. They have
    // to leave `workspaceChannel.ts`'s `PaneView` in the same change — its `UnacceptedPaneProps`
    // assertion is what makes that a compile error rather than a field quietly going nowhere.
    const source = (await import('../LivePreview?raw')).default as string
    const props = source.slice(source.indexOf('export interface LivePreviewProps'), source.indexOf('export default function LivePreview'))

    expect(props).not.toMatch(/^\s*hasSavedBuild\??:/m)
    expect(props).not.toMatch(/^\s*occupyingProjectName\??:/m)
    expect(props).not.toMatch(/^\s*onRelaunch\??:/m)
    // LIVENESS: the slice really is the props block, and the props that stay are still declared.
    expect(props).toMatch(/^\s*previewUrl\?:/m)
    expect(props).toMatch(/^\s*previewState\?:/m)
  })

  it('keeps everything from the frame inward untouched', async () => {
    // The removal was of NO-FRAME chrome. The security seam, the cover, the frame key and the
    // device widths are the parts of this component the workspace redesign explicitly does not
    // touch, and a sweep that took them with the placeholders would be a silent regression on the
    // one thing this file is genuinely load-bearing for.
    const source = (await import('../LivePreview?raw')).default as string

    expect(source).toMatch(/e\.source/)          // the inbound-message gate, on origin AND source
    expect(source).toMatch(/sandbox=/)           // the sandbox token list
    expect(source).toMatch(/const frameKey =/)   // the frame's identity
    // The device WIDTHS are still read here; the TABLE moved out with the control that picks them,
    // so this asserts the import rather than the literal — two copies of it is the
    // drift this guard exists to prevent, not one copy in a new file.
    //
    // IT POINTS AT THE LEAF, not at the toolbar that draws the switcher. Importing the table from
    // the toolbar closed a five-module ring back into this file; `devices.ts` imports nothing of
    // ours, so nothing can import its way back here through it.
    expect(source).toMatch(/import \{ DEVICES, type DeviceName \} from '\.\/workspace\/devices'/)
    expect(source).toMatch(/DEVICES\[device\]\.width/)

    // AND THE LEAF IS STILL A LEAF. The whole value of the move is that `devices.ts` imports
    // nothing of ours, so no ring can form back through it; a relative import added there is what
    // would quietly rebuild the one this replaced.
    const table = (await import('../workspace/devices?raw')).default as string
    expect(table).toMatch(/export const DEVICES/)
    expect(table).not.toMatch(/from '\.\.?\//)
    expect(source).toMatch(/setCovered/)         // the cover that holds on an unknown
  })

  it('★ and the frame-stall cap is still in the file, with the reason it survived', async () => {
    // ★ THE OWNER CARVE-OUT, PINNED. The design deleted every other card in this file on the
    // strength of the serving stamp; this one stays because the stamp does not answer its
    // question. The proof is a loopback GET inside the container; the browser reaches the app
    // through portal nginx → a variable `proxy_pass` → the ACA FQDN, via a resolver with
    // `valid=30s`. A dev server answering locally can still be @app_gone through the router for up
    // to another 30 seconds.
    const source = (await import('../LivePreview?raw')).default as string

    expect(source).toMatch(/const FRAME_LOAD_CAP_MS = 20000/)
    expect(source).toMatch(/Do not delete it on the strength of the stamp/)
    expect(source).toMatch(/frameStalled && !showCover/)
  })
})
