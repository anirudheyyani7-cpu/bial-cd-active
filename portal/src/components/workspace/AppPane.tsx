/**
 * THE APP PANE — what the pane is called, and how to get past it.
 *
 * It contributes the region label, the skip control, and the sentence for when there is nothing
 * to frame. The frame's mounting, identity, hiding and reload nonce are `AppPaneHost`'s; calling
 * `LivePreview` from here builds a second host.
 *
 * The address comes from `previewAddress.ts`, never `PreviewState.previewUrl`, and the workspace
 * state vetoes it only for the names that definitely mean nothing is serving. The pane is a
 * cross-origin iframe, so the way past it lives outside it. ACA wildcard DNS answers for
 * hostnames whose container is gone, so the empty, stopped and gone states are drawn here.
 */
import { memo, useCallback } from 'react'
import { Box, Locate, Play, type LucideIcon } from 'lucide-react'
import AppPaneHost from './AppPaneHost'
import { HIDDEN_BUT_MOUNTED } from './hiddenSubtree'
import { inertWhile, usePaneLeaving } from './paneExit'
import StartAppControl from './StartAppControl'
import type { DeviceName } from './devices'
import { WORKSPACE_RAIL_ID } from './railId'
import { useWorkspaceAddress, useWorkspacePaneVisible, useWorkspaceReport } from './workspaceChannel'
import type { WorkspaceStateName } from './workspaceState'

/** See `frameIt` below. Kept beside the component so the veto's members are readable at a glance. */
const NOTHING_IS_SERVING: ReadonlySet<WorkspaceStateName> = new Set<WorkspaceStateName>([
  'not-running',
  'never-built',
  'held-by-another-project',
  'held-unattributed',
  // `starting` means a start is in flight, with no container yet, and a held address can outlive
  // the one behind it — so framing on it showed an app while the platform was still bringing one
  // up. The wait is what the map's `starting` arm says, and it is the honest thing to show.
  'starting',
])

/**
 * THE MARK ABOVE THE HEADLINE, ON THE THREE STATES WHOSE BOARDS DRAW ONE. `NothingBuilt`,
 * `PreviewOff` and `PreviewStarting` each put a 30px #9AA5B1 glyph directly above their headline;
 * without it a blank half-screen reads as a page that failed to load. A lookup here rather than a
 * field on `WorkspaceState`, which stays a pure module: the words are the map's, the icon is
 * local. `null` is an answer, not a gap — exhaustive over `WorkspaceStateName` so a new state
 * cannot be added without someone deciding here.
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
  // THE COLUMN ITSELF ANSWERS TO THE VISIBILITY, NOT ONLY THE FRAME INSIDE IT.
  //
  // `AppPaneHost` hides itself when no surface declares a pane — but the host is only reached when
  // there is something to frame. A plan chat is the opposite case: nothing to frame AND no pane
  // declared, so `frameIt` is false, `NoFrame` renders instead of the host, and this section's
  // `flex-1` went on claiming half the window for a card offering to start an app the citizen did
  // not ask for. That is exactly the layout `PlanChat` forbids: the board draws one
  // centred column across the full width, and `ConversationSurface`'s `mx-auto max-w-3xl` cannot
  // centre inside a rail that is only half the screen.
  //
  // ZERO IN BOTH DIRECTIONS, because this column sits in a flex row above the stacking threshold
  // and a flex COLUMN below it — a width alone leaves a full-height band under a stacked rail.
  const visible = useWorkspacePaneVisible()
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
            ? // ON ITS WAY OUT. The column keeps its size for one animation while the card
              // slides right and fades — `w-0` here instead would make the keyframe
              // unobservable. The rail beside it is
              // already growing, which is the board's "the conversation is already settling
              // towards the middle of the window".
              'flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden animate-pane-leave'
            : // Hidden, never unmounted — see `AppPaneHost`.
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

      {frameIt ? (
        // THE FRAME IS THE HOST'S, from the frame inward. The device width is passed through
        // rather than held: two owners of one width is how the card and the switcher disagree.
        //
        // IT DRAWS ITS OWN CARD — `LivePreview` frames the iframe in a padded `#e8edf2` box with a
        // rounded, shadowed white surround — which is why the card below is on the EMPTY arm only.
        // A second card around the first would be two borders and two shadows on one app.
        <AppPaneHost device={device} reloadNonce={reloadNonce} leaving={leaving} />
      ) : (
        // THE EMPTY PANE IS A NAMED REGION WITH A CARD IN IT, which is what `PreviewOff`,
        // `NothingBuilt` and `PreviewStarting` draw — and only those three. The label is the tell:
        // it appears on exactly the boards where the pane holds no app, because a blank half of the
        // screen needs to say what it is for, and a running application says that itself. Drawn
        // here rather than at the section, so it comes and goes with the emptiness it explains.
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3.5">
          <p className="mb-2.5 text-[11.5px] font-bold tracking-[0.6px] text-neutral">YOUR APP</p>
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-canvas-rule bg-white shadow-app-card">
            <NoFrame report={report} />
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * WHAT THE PANE SAYS WHEN THERE IS NOTHING TO FRAME — one author, and it is the state map.
 *
 * They are drawn here from one computed value, so a pane sentence has exactly one author and a
 * state nobody is in cannot have chrome drawn for it.
 */
function NoFrame({ report }: { report: ReturnType<typeof useWorkspaceReport> }) {
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
      // on WHICH state the pane reached without pinning the copy, which may change again.
      data-workspace-state={state.name}
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
        {state.action && (
          <div className="mt-5 flex justify-center">
            <StartAppControl action={state.action} report={report} />
          </div>
        )}
      </div>
    </div>
  )
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
