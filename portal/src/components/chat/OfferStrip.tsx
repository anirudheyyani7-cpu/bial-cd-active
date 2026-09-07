/**
 * THE PLAN OFFER, AS A STRIP ON THE COMPOSER. The plan agent calls an offer tool when it judges
 * the plan finished; the browser renders the PENDING call as a strip with two buttons, and
 * pressing either supplies the tool result.
 *
 * WHY SENDING WAITS, AND WHY TWO BUTTONS: a tool call must be answered before the conversation
 * continues, so a typed message while this strip is pending would leave the call open and get the
 * next request rejected. A single "Build this plan" would be a dead end for anyone who wanted to
 * change something, so "Keep planning" answers the call too and hands the box back. Those labels
 * name the mode the press puts you in, and the SAME words appear in the model-facing copy; this
 * file owns only what is drawn. Resolution values stay `build`/`refine` (wire values, unrenamed).
 *
 * THE BROWSER NEVER POSTS THE PLAN TEXT BACK: the server reads it from the offering tool call's
 * own message, and the press sends only the conversation id, the tool call id, and a minted new-
 * chat id. A browser-supplied body would let a stale second tab write stale requirements into the
 * permanent first message.
 *
 * WHY THIS EXISTS — A SPENT STRIP STAYS, AND STAYS PRESSABLE. The first press answers the tool
 * call; the strip then renders spent but REMAINS LIVE, so pressing it again creates another Build
 * chat. Idempotency is storage-free: the press names the chat it creates with a UUIDv7 minted ONCE
 * PER PRESS-SESSION and held in a ref, so a double press or retry carries the same id, collides on
 * the primary key, and the server returns the existing chat. A RELOAD IS OUT OF REACH — a ref dies
 * with the page — so a reload's fresh press-session mints a new id and creates a second Build
 * chat. Asserted by a test; closing it needs storage, a decision nobody has taken.
 */
import { useCallback, useRef, useState, type FC } from 'react'
import { Loader2, Wand2 } from 'lucide-react'

import { uuidv7 } from '../../utils/conversationApi'
import { usePrefersReducedMotion } from './ToolActivityLine'

/** What the press sends. No plan text: the server reads it from the offering tool call. */
export interface BuildHandoff {
  conversationId: string
  toolCallId: string
  /** Client-minted, once per press-session. */
  newChatId: string
}

export interface OfferStripProps {
  /** The pending call's id. A strip without one is not rendered — the card IS its tool-call id. */
  toolCallId: string | null
  conversationId: string | null
  /** True once this offer has been answered — it stays on screen and stays pressable. */
  spent: boolean
  /** Answer the call with `build` and hand off. Resolves when the server has confirmed. */
  onBuild: (handoff: BuildHandoff) => Promise<void>
  /** Answer the call with `refine`, which hands the composer straight back. */
  onKeepPlanning: (toolCallId: string) => Promise<void>
  /** A failed handoff. The reader stays where they are, told what happened. */
  onFailed: (message: string) => void
}

export const BUILD_LABEL = 'Build this plan'
export const KEEP_PLANNING_LABEL = 'Keep planning'
/** The canvas's wording for why sending waits. `ComposerBox` draws it in place of the placeholder. */
export const OFFER_GATE_NOTE = 'Choose one of the two above to carry on…'
/**
 * THE LINE UNDER THE BOX WHILE THE OFFER WAITS, verbatim from `PlanReady` and `PlanRevised`.
 *
 * The boards draw TWO sentences, not one. The gate note above sits in the box and says the box is
 * not where the answer goes; this one sits under it, centred and in the strip's own teal, and says
 * that neither answer is the wrong answer. Reassurance is the half someone just handed a decision
 * actually needs.
 */
export const OFFER_LOCKED_NOTE =
  'The box is locked until you pick one. Either answer is fine — one opens a Build chat, the other hands the conversation back to you.'
/**
 * WHAT THE STRIP SAYS BEFORE ANYBODY PRESSES ANYTHING, verbatim from `PlanReady`.
 *
 * The board's requirement is about register, not decoration: "this teal strip is not text the
 * agent typed — it is a control the interface draws." Two bare buttons at the box's right read
 * as chrome — nothing says pressing one opens a second chat and leaves this one alone, which is
 * the one thing a citizen wants to know before pressing it.
 */
export const OFFER_HEADLINE = 'This looks ready to build.'
export const OFFER_EXPLANATION =
  'Opens a new Build chat with the message above as its first instruction. This chat stays exactly as it is.'

const OfferStrip: FC<OfferStripProps> = ({
  toolCallId,
  conversationId,
  spent,
  onBuild,
  onKeepPlanning,
  onFailed,
}) => {
  const [busy, setBusy] = useState<'build' | 'refine' | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  // Minted once per PRESS-SESSION and held in a ref, so a double press and a retry carry the
  // same id. `ProjectBuilder` mints through the same shared `uuidv7` but does it INLINE inside
  // `navigate()` with no ref — that site mints on every press by design, which is the opposite of
  // what this needs.
  const mintedRef = useRef<string | null>(null)

  const handleBuild = useCallback(async () => {
    if (busy || !toolCallId || !conversationId) return
    mintedRef.current ??= uuidv7()
    setBusy('build')
    try {
      // NO optimistic navigation. It moves only on a confirmed response — deriving "it worked"
      // from anything less is how a spent strip with no build behind it happens.
      await onBuild({ conversationId, toolCallId, newChatId: mintedRef.current })
    } catch {
      onFailed('Could not start the build. Nothing has changed — try again.')
    } finally {
      setBusy(null)
    }
  }, [busy, toolCallId, conversationId, onBuild, onFailed])

  const handleKeepPlanning = useCallback(async () => {
    if (busy || !toolCallId) return
    setBusy('refine')
    try {
      await onKeepPlanning(toolCallId)
    } catch {
      onFailed('Could not answer that. Try again.')
    } finally {
      setBusy(null)
    }
  }, [busy, toolCallId, onKeepPlanning, onFailed])

  // The card IS its tool-call id. Without one there is nothing to answer, so the strip is not
  // rendered at all and the composer is left unblocked — never a dead button.
  if (!toolCallId) return null

  const spin = reducedMotion ? undefined : 'animate-spin'

  return (
    // A BAND ACROSS THE TOP OF THE BOX, edge to edge — the negative margins undo the composer's own
    // padding so the strip meets its border, which is what "fixed to the top of the message box"
    // means on the board. `ComposerBox` turns the box's own border teal while this is mounted, so
    // the two read as one card.
    <div
      data-testid="offer-strip"
      data-spent={spent ? 'true' : 'false'}
      className={`-mx-3 -mt-[11px] flex flex-wrap items-center gap-3 rounded-t-[13px] border-b border-canvas-offerrule bg-canvas-offer px-3.5 py-3 ${
        spent ? 'opacity-70' : ''
      }`}
    >
      <Wand2 size={18} aria-hidden className="flex-shrink-0 text-primary" />

      <div className="min-w-0 flex-1 basis-48">
        <p className="text-[12.5px] font-bold text-canvas-offerink">{OFFER_HEADLINE}</p>
        <p className="mt-0.5 text-[11px] leading-[1.55] text-neutral">{OFFER_EXPLANATION}</p>
      </div>

      <button
        type="button"
        onClick={handleKeepPlanning}
        aria-disabled={busy !== null}
        data-testid="offer-keep-planning"
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-slate-300 bg-white px-3.5 py-2.5 text-[12.5px] font-semibold text-slate-600 transition hover:border-primary hover:text-primary"
      >
        {busy === 'refine' && <Loader2 size={13} className={spin} />}
        {KEEP_PLANNING_LABEL}
      </button>
      <button
        type="button"
        onClick={handleBuild}
        aria-disabled={busy !== null}
        data-testid="offer-build"
        className="inline-flex items-center gap-[7px] whitespace-nowrap rounded-[10px] bg-primary px-[15px] py-2.5 text-[12.5px] font-bold text-white transition hover:bg-primary-600"
      >
        {busy === 'build' ? <Loader2 size={13} className={spin} /> : <Wand2 size={13} aria-hidden />}
        {BUILD_LABEL}
      </button>
    </div>
  )
}

export default OfferStrip
