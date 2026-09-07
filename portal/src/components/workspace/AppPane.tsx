/**
 * THE APP PANE (Plan F, U4) — what the pane is called, and how to get past it.
 *
 * ═══ IT CONTRIBUTES THREE THINGS AND MOUNTS NO IFRAME ═══
 *
 * The region label, the skip control, and the sentence for when there is nothing to frame. The
 * frame's mounting, its identity, its hiding and its reload nonce all stay in Plan A's
 * `AppPaneHost`. An implementer who calls `LivePreview` from here has built a SECOND host, and a
 * second host is the remount that AE4 and AE37 exist to forbid — the app would reload on every
 * navigation and every crossing of the layout threshold, with nothing red anywhere.
 *
 * This removes work rather than adding it: the pane needs no framing logic of its own.
 *
 * ═══ THE SEAM: THE RESOLVED ADDRESS, AND THE STATE THAT CAN INVALIDATE IT ═══
 *
 * The address comes from `previewAddress.ts` — never `PreviewState.previewUrl` — with its
 * precedence intact: the live turn's preview outranks the session URL, because the live turn is
 * the app being built in front of the person while the session URL describes the previous build.
 *
 * TWO THINGS AN EARLIER CUT OF THIS FILE GOT WRONG BY READING ONLY `address.url`, both caught by
 * the suites that pin the surfaces around this one:
 *
 *  1. A URL IS NOT THE ONLY THING THE RESOLVER RETURNS. Its own docblock says so: "a build that is
 *     provisioning has a STATUS and no URL yet, and that pair is what renders the loading state
 *     instead of an empty pane". Gating on the URL alone put "We could not check on your app." in
 *     front of a citizen watching their first build come up.
 *  2. AN ADDRESS OUTLIVES ITS PUBLISHER, DELIBERATELY — that is R8's whole mechanism — so a URL
 *     stays held after the container behind it has stopped. Framing it regardless meant an app
 *     that went to sleep showed a card saying "nothing is lost" with NO way to bring it back:
 *     R3's "exactly one control starts it", satisfied by zero, in an ordinary state.
 *
 * So the workspace state gets a veto, and only for the states that DEFINITELY mean nothing is
 * serving. `could-not-read` is pointedly not one of them: an answer that decided nothing must not
 * pull a working app off the screen, which is the rule the whole preview reshape exists for.
 *
 * ═══ WHY A SKIP CONTROL, AND WHY IT CANNOT LIVE INSIDE THE FRAME ═══
 *
 * The pane is a cross-origin iframe. It swallows the tab sequence into a document whose length
 * nothing here can know, and whose focus behaviour is the generated app's business — so a way PAST
 * it has to exist outside it. Without one, a person navigating by keyboard is trapped in somebody
 * else's application (R67).
 *
 * Nothing here makes any claim about the framed document's own accessibility. The pane says what it
 * is; what is inside is the app's.
 *
 * ═══ WHY THE TAKE-BACK'S SEQUENCE AND DIALOG ARE MOUNTED HERE (`#196`, U13) ═══
 *
 * The verb belongs to `StartAppControl` and the sequence is its hook; what this file contributes is
 * a MOUNT POINT THAT OUTLIVES THE WAIT, which is `#210`'s rule for a live region and is the same
 * rule for a modal. The wait is up to two minutes with a stop running behind it, and the controls
 * that started it are the first thing to go: the held arm's two buttons live inside `NoFrame`,
 * which stops rendering the instant the state moves. A dialog owned by one of those buttons is a
 * dialog that disappears mid-sequence, which is precisely the outcome D2's endings are written
 * against — and the same reasoning covers the "both buttons go inert" rule, which is a fact about a
 * pair of siblings and so can only be held by their parent.
 *
 * IT IS RENDERED OUTSIDE THE SECTION, deliberately. The section carries `aria-hidden` and `inert`
 * whenever no surface wants the pane, and a modal drawn inside it would be announced as absent and
 * be unreachable by keyboard on the one screen where it is the only thing that matters.
 *
 * AND THE SAME LIFETIME IS WHY THE HOOK IS HANDED THE WHOLE `report` RATHER THAN A HANDLER OR TWO.
 * This pane outlives the WAIT, which is what the modal needs — but it also outlives the PROJECT,
 * because it is a sibling of the Outlet and a move between two projects re-renders it without ever
 * unmounting it. So the sequence needs an identity of its own or it carries over, and the identity
 * it uses is `report.projectId`. See `useTakeBack`'s docblock; nothing about it is decided here.
 *
 * ═══ L10 — DO NOT ASSUME THE APPS ROUTER SERVES A BRANDED PAGE ═══
 *
 * ACA wildcard DNS answers for hostnames whose container is long gone, so an "app is gone" 404 is
 * not a reliable discriminator and a framed URL can resolve to a working-looking host serving
 * nothing. The empty, stopped and gone states are therefore drawn HERE, from the workspace state,
 * rather than left to whatever the framed origin happens to return.
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { Box, Locate, Play, type LucideIcon } from 'lucide-react'
import AppPaneHost from './AppPaneHost'
import { HIDDEN_BUT_MOUNTED } from './hiddenSubtree'
import { inertWhile, usePaneLeaving } from './paneExit'
import StartAppControl, { useTakeBack, type TakeBack } from './StartAppControl'
import ReclaimWorkspaceDialog from '../projects/ReclaimWorkspaceDialog'
import type { DeviceName } from './devices'
import { WORKSPACE_RAIL_ID } from './railId'
import {
  useWorkspaceAddress,
  useWorkspaceHeading,
  useWorkspacePaneVisible,
  useWorkspaceReclaim,
  useWorkspaceReport,
} from './workspaceChannel'
import type { WorkspaceStateName } from './workspaceState'

/** See `frameIt` below. Kept beside the component so the veto's members are readable at a glance. */
const NOTHING_IS_SERVING: ReadonlySet<WorkspaceStateName> = new Set<WorkspaceStateName>([
  'not-running',
  'never-built',
  'held-by-another-project',
  'held-unattributed',
  // `starting` IS one of these, and the wire says so in as many words: it means "a start is in
  // flight … not `alive` (NO CONTAINER YET)". A held address survives its publisher, so without
  // this a press over a stale URL re-framed a container that is not there — the pane showing an
  // app while the platform is still bringing one up. The wait is the honest thing to show, and it
  // is what the map's `starting` arm says.
  'starting',
])

/**
 * THE MARK ABOVE THE HEADLINE, ON THE THREE STATES WHOSE BOARDS DRAW ONE.
 *
 * `NothingBuilt`, `PreviewOff` and `PreviewStarting` are the boards for an empty pane, and every
 * one of them puts a 30px #9AA5B1 glyph directly above its headline: a ticked circle, a play
 * triangle and a box. Without it the pane is a headline and a sentence floating in a white card,
 * and a blank half-screen with no mark on it reads as a page that failed to load rather than as a
 * deliberate state.
 *
 * IT IS A LOOKUP HERE AND NOT A FIELD ON `WorkspaceState`, deliberately. The state map is a pure
 * module answering "what is true and what may be pressed"; a Lucide component is a rendering
 * decision, and `chatKind.ts` already draws that line the same way — the words are the catalogue's,
 * the icon and the pill are local. What the map still owns is every sentence on this pane.
 *
 * `null` IS AN ANSWER, not a gap: no board draws a mark for the hand-over states, the read
 * failures or the three start outcomes, and inventing seven glyphs the canvas has never shown
 * would be this file making the design decision. Exhaustive over `WorkspaceStateName` so a new
 * state cannot be added without someone deciding here.
 */
const STATE_GLYPH: Readonly<Record<WorkspaceStateName, LucideIcon | null>> = {
  'never-built': Locate, // NothingBuilt — the ticked circle, the same mark the rail's Plan picker has
  'not-running': Play, // PreviewOff — "Your app is saved", and the press that brings it back
  starting: Box, // PreviewStarting — "Setting up somewhere for it to run"
  running: null, // The frame is up; this pane draws no card at all.
  'held-by-another-project': null,
  'held-unattributed': null,
  'could-not-read': null,
  'not-painted': null,
  'timed-out': null,
  'start-failed': null,
}

export interface AppPaneProps {
  /** The width the app is framed at. Shell-owned, because its control is in the toolbar row. */
  device: DeviceName
  /** Bumped by the row's Reload control; the frame re-requests its document on a change. */
  reloadNonce: number
}

function AppPane({ device, reloadNonce }: AppPaneProps) {
  const address = useWorkspaceAddress()
  const report = useWorkspaceReport()
  // THE COLUMN ITSELF ANSWERS TO THE VISIBILITY, NOT ONLY THE FRAME INSIDE IT (plan 002, U6).
  //
  // `AppPaneHost` hides itself when no surface declares a pane — but the host is only reached when
  // there is something to frame. A plan chat is the opposite case: nothing to frame AND no pane
  // declared, so `frameIt` is false, `NoFrame` renders instead of the host, and this section's
  // `flex-1` went on claiming half the window for a card offering to start an app the citizen did
  // not ask for. That is exactly the layout `PlanChat` forbids and U6 promises: the board draws one
  // centred column across the full width, and `ConversationSurface`'s `mx-auto max-w-3xl` cannot
  // centre inside a rail that is only half the screen.
  //
  // ZERO IN BOTH DIRECTIONS, because this column sits in a flex row above the stacking threshold
  // and a flex COLUMN below it — a width alone leaves a full-height band under a stacked rail.
  const visible = useWorkspacePaneVisible()
  // THE TAKE-BACK'S WHOLE SEQUENCE (`#196`) — held here because this is what outlives it. See the
  // docblock. `null` when nobody has computed a state; the hook is unconditional, as hooks are.
  //
  // THE WHOLE REPORT, NOT ITS HANDLERS: the hook reads `projectId` off it to know whose sequence
  // it is holding, and a pane that outlives a navigation would otherwise carry one project's
  // dialog and busy flag onto the next.
  const takeBack = useTakeBack(report)
  // The shell's hand-over question, if one is up. See the render site below: exactly one of the
  // two identical dialogs is on screen at a time, and the one with a parked send behind it wins.
  const reclaim = useWorkspaceReclaim()
  // THE APP THE CITIZEN IS TRYING TO OPEN — issue `#161`'s framing half, which the dialog leads
  // with. Published by the routes (`ProjectPage` / `ChatRoute`), not by the surfaces, so it is read
  // from the channel rather than derived here. `null` before a project's own fetch lands, and the
  // dialog then falls back to its plain phrasing rather than quoting an empty string.
  const heading = useWorkspaceHeading()
  // THE EXIT THE BOARD DRAWS, and the reason it needs a state of its own: see `paneExit.ts`. This
  // column is the outermost thing that collapses, so the hold is decided here and handed to the
  // host — the two must not disagree about whether they are still on their way out.
  const leaving = usePaneLeaving(visible)

  /**
   * MOVE FOCUS BACK TO THE RAIL, and do it by focusing the region rather than hunting for its
   * first control. A `tabindex="-1"` container is programmatically focusable without joining the
   * tab order, so the next Tab continues from the rail's top — which is what a person escaping the
   * frame actually wants. Querying for "the first button" would break the moment the rail's first
   * element is not one.
   */
  // THE STATES THAT MEAN NOTHING IS SERVING, and therefore that a held address is stale.
  //
  // `could-not-read` is deliberately absent: a read that decided nothing must not retire a frame
  // somebody is looking at. So are the three start outcomes — they describe a press that did not
  // land, not a container that went away, and a frame already up is evidence enough.
  const stale = report !== null && NOTHING_IS_SERVING.has(report.state.name)
  // A STATUS WITH NO URL IS THE LOADING STATE, not an empty pane — see the docblock.
  const frameIt = !stale && (address.url !== null || address.status !== null)

  const skipPastTheApp = useCallback(() => {
    const rail = document.getElementById(WORKSPACE_RAIL_ID)
    if (!rail) return
    if (!rail.hasAttribute('tabindex')) rail.setAttribute('tabindex', '-1')
    rail.focus()
  }, [])

  return (
    <>
      <section
        data-testid="app-pane-region"
        aria-label="Your app"
        // ANNOUNCED AS GONE THE MOMENT IT IS UNWANTED, even while it is still on its way out. The
        // movement is for the eye; a reader who is not watching it should not be told about an app
        // that is leaving.
        aria-hidden={!visible}
        // AND OUT OF REACH ON THE SAME FACT, from the same moment. `aria-hidden` is the half a
        // screen reader obeys; this is the half a keyboard obeys, and they are given one condition
        // so they cannot come apart.
        //
        // IT IS THE LEAVE THAT NEEDS IT. At rest the pane is `visibility:hidden`, which drops its
        // subtree from the tab order on its own — but the column holds its SIZE for one animation so
        // the card can be watched going, and an invisible element has nothing to animate. For that
        // quarter of a second the skip control below and the framed app were both still one Tab
        // away, on a region already announced as gone. See `paneExit.ts` for the empty string.
        {...inertWhile(!visible)}
        className={
          visible
            ? 'flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden'
            : leaving
              ? // ON ITS WAY OUT (plan 002, U6). The column keeps its size for one animation while
                // the card slides right and fades — `w-0` here instead would make the keyframe
                // unobservable, which is why the utility existed unused. The rail beside it is
                // already growing, which is the board's "the conversation is already settling
                // towards the middle of the window".
                'flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden animate-pane-leave'
              : // Hidden, never unmounted — the whole point of the sibling host is that leaving a
                // build chat for a plan chat must not re-issue the frame's `src`.
                `w-0 h-0 flex-shrink-0 overflow-hidden ${HIDDEN_BUT_MOUNTED}`
        }
      >
        {/* VISIBLE ON FOCUS ONLY. It is the standard skip-link treatment: out of the way for a
            pointer, and the first thing a keyboard reaches on its way into the frame. */}
        <button
          type="button"
          onClick={skipPastTheApp}
          className="sr-only focus:not-sr-only focus:absolute focus:z-30 focus:m-2 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          Skip past your app
        </button>

        {/* THE COLLAPSE CONTROL IS NOT HERE ANY MORE (plan 002, U2). It moved to the toolbar row,
            which is drawn once above the two-column grid. Here it was already better than living
            inside the rail it hides — a collapsed rail is invisible and untabbable, so a toggle in
            it is a one-way door — but it still appeared and disappeared with the pane. In the row it
            has one home in every state, beside the title that now also survives a collapse. */}

        {/* ═══ THE PANE'S LIVE REGION, MOUNTED UNCONDITIONALLY AND WRAPPING ITS CONTENT (R30) ═══

            IT USED TO LIVE INSIDE THE ROW THAT DRAWS THE BUTTONS, which meant the one state with a
            wait in it and no button — `starting`, whose `action` is `null` — had NO REGION AT ALL.
            A citizen sat through a two-minute sandbox start with nothing said, entering or leaving.
            That is the whole defect R30 names, and moving this element out of `NoFrame`'s
            `state.action &&` block is the whole of the fix: the region is now born with the pane,
            holds whatever the board is saying, and outlives every transition between boards.

            IT WRAPS THE EMPTY-PANE CONTENT AND POINTEDLY NOT THE FRAMED HOST. `LivePreview` keeps
            its own permanent region and speaks for every framed state; wrapping the host as well
            would put a second polite region around the first and announce the cover, the stall and
            the reveal twice — the exact duplication `LivePreview`'s own docblock forbids. The two
            regions divide the pane between them: this one owns the states with no app in them.

            SO WHEN THE APP IS FRAMED THIS ELEMENT IS EMPTY, and it keeps standing anyway. A live
            region inserted together with its text announces inconsistently — the convention stated
            at `LivePreview.tsx` and at `TurnBanner.tsx` — so it must exist before it has anything
            to say. Empty, its only child is absolutely positioned, so it occupies no height and the
            host beside it is unaffected. */}
        <div
          data-testid="app-pane-live"
          role="status"
          aria-live="polite"
          // NO `aria-busy` HERE, DELIBERATELY. The wait's busy flag goes on the board that draws
          // the wait (see `NoFrame`), because `aria-busy` on a live region tells a reader to hold
          // its announcements until the busy clears — which would silence the very "entering the
          // wait" announcement this region exists to make.
          className={frameIt ? '' : 'flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3.5'}
        >
          {!frameIt && (
            // THE EMPTY PANE IS A NAMED REGION WITH A CARD IN IT, which is what `PreviewOff`,
            // `NothingBuilt` and `PreviewStarting` draw — and only those three. The label is the
            // tell: it appears on exactly the boards where the pane holds no app, because a blank
            // half of the screen needs to say what it is for, and a running application says that
            // itself. Drawn here rather than at the section, so it comes and goes with the
            // emptiness it explains.
            <>
              {/* DECORATIVE, and it has to be now that it is inside the region: the section above
                  is already labelled "Your app", so this caption is that label a second time, and
                  a reader would otherwise hear "YOUR APP" announced every time the pane emptied. */}
              <p
                aria-hidden="true"
                className="mb-2.5 text-[11.5px] font-bold tracking-[0.6px] text-neutral"
              >
                YOUR APP
              </p>
              <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-canvas-rule bg-white shadow-app-card">
                <NoFrame report={report} takeBack={takeBack} />
              </div>
            </>
          )}
          {/* ═══ WHAT A TAKE-BACK THAT WORKED DID TO THE OTHER PROJECT (R44c, U11) ═══

              THE FAILURE ARM ALREADY HAD A SENTENCE and it is NOT produced here: the map writes it
              onto `state.note` and the board above renders it, and it announces now purely because
              this region moved. A second producer for it would be the same news said twice.

              THE SUCCESS ARM HAD NOTHING, which is the half this adds. A take-back that works ends
              with the other citizen's app stopped and this pane quietly framing an app — so the
              person who pressed it learned nothing at all about what they had just taken. It is
              `sr-only` because on this ending the pane is showing the running app: there is no card
              left to put a sentence in, and a line floating over the frame would be the pane
              talking about itself. Nothing else on screen says it, so this is not a duplicate. */}
          {takeBack.outcome !== null && <p className="sr-only">{takeBack.outcome}</p>}
        </div>
        {/* THE FRAME IS THE HOST'S. Everything from the frame inward — the cover that holds on an
            unknown, the `load`-gated reveal, the frame key, the inbound-message gate on origin AND
            source, the sandbox token list — is unchanged and stays there. The device WIDTH is the
            shell's now, because the control that picks it is in the row, and it is passed through
            rather than held: two owners of one width is how the card and the switcher disagree.

            IT DRAWS ITS OWN CARD — `LivePreview` frames the iframe in a padded `#e8edf2` box with a
            rounded, shadowed white surround — which is why the card above is on the EMPTY arm only.
            A second card around the first would be two borders and two shadows on one app. */}
        {frameIt && <AppPaneHost device={device} reloadNonce={reloadNonce} leaving={leaving} />}
      </section>
      {/* THE QUESTION `#196` ROUTES THE TAKE-BACK THROUGH (D1) — the dialog that already exists,
          with its three copy arms and its `agentWorking` sentence reused unchanged. No new copy is
          written for it anywhere in this unit.

          FORCE-REMOUNTED, KEYED ON THE HOLDER, and that is not a rendering nicety. When another tab
          takes the freed slot mid-sequence the refusal names a DIFFERENT project, and this dialog
          captures focus in a MOUNT-time effect: updating it in place would leave a keyboard user's
          focus parked on the card where the busy state put it, while the copy in front of them
          silently changed which project it is talking about — an irreversible choice, re-aimed
          under their hands. A new key is a new mount, so the focus goes where the new question is.

          AND THE HANDLERS ARE PASSED THROUGH RATHER THAN WRAPPED. The dialog's `run()` turns any
          rejection into its own alert and stays up; every ending of `resolve` resolves, and the
          pane behind is what reports. */}
      {/* ═══ ONE HAND-OVER QUESTION AT A TIME (R44, `#187`) ═══
          This dialog and the shell's are LITERALLY THE SAME COMPONENT mounted from two places —
          the shell's from a send the platform refused, this one from the citizen pressing take
          back. They are visually identical, so with both up the citizen answers whichever is on
          top believing it is the one they opened, and "Switch anyway" on the shell's lets the
          refused send through — starting the very build the take-back exists to avoid.

          THE SHELL'S WINS, and the direction is not arbitrary: a reclaim on the channel has a
          PENDING PROMISE behind it — the send is parked waiting for an answer — so refusing to
          render it would strand that send forever. The take-back has no such debt.

          AND THIS HOLDS THE QUESTION RATHER THAN DROPPING IT. `takeBack.asking` stays set; only
          the render waits. When the reclaim clears, this dialog appears with its question intact,
          so a citizen who pressed take back is never silently ignored. */}
      {takeBack.asking && reclaim === null && (
        <ReclaimWorkspaceDialog
          key={takeBack.asking.projectId}
          blocked={takeBack.asking}
          startingProjectName={heading.projectName}
          step={takeBack.step}
          onSaveAndSwitch={() => takeBack.resolve(true)}
          onSwitchAnyway={() => takeBack.resolve(false)}
          onCancel={takeBack.cancel}
        />
      )}
    </>
  )
}

/**
 * WHAT THE PANE SAYS WHEN THERE IS NOTHING TO FRAME — one author, and it is the state map.
 *
 * These arms used to live inside `LivePreview` as a six-prop placeholder precedence spelled at the
 * pane's edge (`showRestoring` / `showTerminal` / `showReconnecting` / `showUnavailable`). They are
 * removed there and drawn here from one computed value, so a pane sentence has exactly one author
 * and a state nobody is in cannot have chrome drawn for it.
 */
function NoFrame({
  report,
  takeBack,
}: {
  report: ReturnType<typeof useWorkspaceReport>
  takeBack: TakeBack
}) {
  // NOBODY HAS COMPUTED A STATE. A surface mounted outside a workspace, or one still resolving its
  // project. Saying nothing is the honest answer — inventing a sentence here would be a second
  // author for the one thing this whole design gives a single one.
  if (!report) return null

  const { state } = report
  // See `STATE_GLYPH`: the three boards that draw an empty pane draw a mark above the headline,
  // and the states no board covers draw none rather than borrowing one.
  const Glyph = STATE_GLYPH[state.name]
  return (
    <div
      data-testid="app-pane-empty"
      // THE INTERNAL STATE NAME, EXPOSED FOR TESTS AND NEVER RENDERED. `not-running` is the one to
      // watch: it is a state name here and on the wire, and the exact phrase R-16 forbids on
      // screen. It is an attribute rather than text for that reason — and it gives a suite a handle
      // on WHICH state the pane reached without pinning the copy, which the client has changed
      // twice and may change again.
      data-workspace-state={state.name}
      // THE BUSY STATE R27 ASKS FOR, on the board that draws the wait rather than on the region
      // that announces it — the same placement `LivePreview`'s `BouncingWait` already uses. It is
      // a property, not a speech: it marks this content as unsettled without saying anything, so
      // the region above stays free to announce the wait entering and leaving.
      //
      // FROM THE MAP, NEVER FROM `state.name === 'starting'` HERE. A second derivation of the same
      // claim is a second author for it; see `WorkspaceState.busy`.
      aria-busy={state.busy === true}
      className="flex flex-1 items-center justify-center p-8"
    >
      <div className="flex max-w-sm flex-col items-center text-center">
        {/* 30px, 1.6 stroke, #9AA5B1 — the board's own numbers, 14px above the headline.
            Decorative: the headline beneath it says the same thing in words. */}
        {Glyph && (
          <Glyph
            data-testid="app-pane-glyph"
            size={30}
            strokeWidth={1.6}
            aria-hidden="true"
            className="mb-3.5 flex-shrink-0 text-canvas-placeholder"
          />
        )}
        <p className="text-base font-bold text-tertiary">{state.headline}</p>
        {state.detail && <p className="mt-2 text-sm text-neutral leading-relaxed">{state.detail}</p>}
        {/* WHAT A TAKE-BACK DID TO SOMEBODY ELSE'S APP (D2) — its own line, because it has its own
            subject. Emphasised rather than greyed: it is the half of the outcome a citizen cannot
            find out any other way without opening the other project. */}
        {state.note && (
          <p data-testid="app-pane-note" className="mt-2 text-sm font-semibold text-tertiary leading-relaxed">
            {state.note}
          </p>
        )}
        {/* HOW LONG THIS HAS BEEN GOING ON (R28) — the honest half of the progress bar D2 dropped.
            A still card that never changes reads as a hung screen after about twenty seconds; a
            number that moves is the cheapest possible evidence that the platform is still working,
            and unlike a bar every position on it is a measured fact. */}
        {state.busy === true && <ElapsedSinceTheWaitBegan />}
        {/* THE ROW IS NO LONGER THE POLITE REGION (R30). It was, and that was the defect: a region
            mounted inside `state.action &&` does not exist on the one state that has a wait and no
            action. The region moved up to `AppPane`, where it wraps this whole board — so the
            take-back still renames ITSELF inside it and is still announced once on entering and
            again on leaving, and the headline, the detail and the note are announced too. */}
        {state.action && (
          <div className="mt-5 flex flex-wrap justify-center gap-2.5">
            <StartAppControl action={state.action} report={report} inert={takeBack.working} />
            {state.secondAction && (
              <StartAppControl
                action={state.secondAction}
                report={report}
                takeBack={takeBack}
                inert={takeBack.working}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * HOW LONG THE WAIT HAS BEEN RUNNING — R28's elapsed time, and the one number on this pane.
 *
 * ═══ WHY IT IS A COUNT AND NOT A BAR (D2) ═══
 *
 * R28 asks for a bar whose fill is STEP-determinate, advancing on the workspace claim, the
 * container start and the first document served. The platform observes all three and the browser
 * can read none of them: they happen inside one synchronous backend call and the wire carries a
 * single opaque `starting`/`ready` field. A bar built on what IS readable could only be
 * time-determinate, and R28's own text rules that out — "a bar that sits at 80% for two minutes is
 * worse than the honest still card". Elapsed time is what is left that is true.
 *
 * ═══ IT COUNTS FROM ITS OWN MOUNT, WHICH IS EXACTLY THE WAIT ═══
 *
 * No timestamp travels on the report and none needs to: this renders only while `state.busy`, so
 * mounting IS the wait beginning and unmounting IS it ending. A stamp on the state would have to be
 * compared in `sameWorkspaceState` — where a value that changes every render defeats the whole
 * comparator — and would re-render the entire shell once a second for a number only this pane
 * shows.
 *
 * ═══ AND IT IS NOT ANNOUNCED ═══
 *
 * `aria-live="off"` because this element sits INSIDE the pane's polite region, and a counter that
 * ticks inside a live region is a screen reader reading a number every second for two minutes. Off
 * on the nearest ancestor means the value is still in the accessibility tree — a reader can go and
 * read it whenever they want to know — without being pushed at anybody.
 */
function ElapsedSinceTheWaitBegan() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const tick = setInterval(() => setSeconds((was) => was + 1), 1_000)
    return () => clearInterval(tick)
  }, [])
  return (
    <p
      data-testid="app-pane-elapsed"
      aria-live="off"
      className="mt-3 text-xs tabular-nums text-neutral"
    >
      {formatElapsed(seconds)} so far
    </p>
  )
}

/** `0s`, `45s`, `1m 05s`. Seconds stay two-digit past the minute so the line does not jitter. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * MEMOISED BECAUSE THE RAIL DRAG RE-RENDERS THE SHELL ON EVERY POINTER MOVE. `RailResizeHandle`
 * reports each move into the shell's own width state, and this column is its sibling — so without
 * this the whole pane subtree re-renders at pointer frequency for the length of a drag, for a
 * width that is not its own. Both props are primitives, so the default shallow compare is exactly
 * right; nothing else this component reads comes through props, and context and cell subscriptions
 * reach it regardless of memo.
 */
export default memo(AppPane)
