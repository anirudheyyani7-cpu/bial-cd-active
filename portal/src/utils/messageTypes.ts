/**
 * The shared `parts[]` message-content model — the one thing every producer and
 * consumer of a chat message (the `conversationApi` reload projection, the live
 * turn stream, `MessageContent`'s render, `attachmentStore`'s transforms) agrees
 * on the shape of. This did NOT exist as a type anywhere before this file — it is derived
 * from the real construction/consumption sites, not invented:
 *
 *   - `TextPart`/`FilePart` (all three `file` sub-shapes) come verbatim from the
 *     JSDoc contract at the top of `attachmentStore.js`, the module that owns
 *     the parts<->wire transform.
 *   - `PlanOptionsPart`/`StepPart` wrap the already-typed `PlanOptionsItem`/
 *     `StepItem` from `turnStreamApi.ts` rather than re-declaring them — both
 *     are constructed ONLY by `conversationApi.js`'s `messagesFromProjection`
 *     (the reload path); the live path never builds these two part kinds
 *     directly.
 *   - `BuildInProgressPart` likewise comes from `messagesFromProjection`.
 *   - `BuildPart` is the one case with a real pre-existing inconsistency
 *     between producers (see below) — this file makes it visible rather than
 *     papering over it.
 *
 * PRE-EXISTING INCONSISTENCY, STILL NOT FIXED: the persisted/reload `build` part
 * (`conversationApi`'s `messagesFromProjection`, the `banner` branch) and the live
 * `build` part carry different field sets under the same `type:'build'`
 * discriminant. Both producers named here originally lived on the deleted builder
 * page; the divergence outlived it, which is why the two named types below are
 * still worth keeping apart. No consumer has ever distinguished them — every field
 * is read via plain optional access regardless of producer, which is why this was
 * never a runtime bug.
 * `BuildPartPersisted` and `BuildPartLive` are kept as two distinct named
 * types, unioned, rather than collapsed into one everything-optional shape, so
 * the divergence stays legible to a future reader.
 *
 * UPDATE: `attachmentStore.ts` has since converted — its real construction
 * sites confirmed this file's shapes, with one revision: `FilePartOffice`
 * gained `truncationNote` (was missing when this file was first written).
 *
 * IT CARRIES ONE PIECE OF RUNTIME CODE, and only because the same reasoning that put the shapes
 * here applies to it: `outcomeSummary` turns a build part's own fields into the sentence a citizen
 * reads, and BOTH producers of that part need it — the surface that draws the live terminal and
 * the projection that rebuilds it after a reload. A util cannot import a component, so a leaf both
 * already depend on is the only place one copy of that sentence can live (#204).
 */
import type { PlanOptionsItem, StepItem } from './turnStreamApi'

/** Prose part — optionally an inline csv/txt attachment (content lives in `text`,
 * shown as a chip, re-inlined every turn). */
export interface TextPart {
  type: 'text'
  text: string
  attachment?: {
    attachmentId: string
    name: string
    mediaType: string
    size: number
  }
}

/** Image/PDF bytes living in the object store. */
export interface FilePartImageOrDocument {
  type: 'file'
  kind: 'image' | 'document'
  attachmentId: string
  key: string
  name: string
  mediaType: string
  size: number
}

/** A HYBRID: original .docx/.xlsx bytes live in the object store (chip
 * re-downloads them) but are NEVER sent to the model — the server-extracted
 * Markdown (`text`) is sent as a sticky text block instead. */
export interface FilePartOffice {
  type: 'file'
  kind: 'office'
  format: 'word' | 'excel'
  attachmentId: string
  key: string
  name: string
  mediaType: string
  size: number
  text: string
  truncated: boolean
  /** Human-readable truncation detail for the chip tooltip; only set when
   * `truncated` is true. Added converting attachmentStore.ts — flagged as
   * missing when this file was first written (Step 1), before
   * attachmentStore.js's real construction site (`buildUserParts`) was
   * traced. */
  truncationNote?: string
}

/** A .pptx: original bytes live in the object store (chip re-downloads them);
 * the model sees a sticky vision `document` block referencing the INTERNAL
 * converted PDF by `pdfFileId` (never the .pptx, never base64) — the PDF is
 * invisible to the user, only the .pptx is ever surfaced. */
export interface FilePartDeck {
  type: 'file'
  kind: 'deck'
  attachmentId: string
  key: string
  name: string
  mediaType: string
  size: number
  pdfFileId: string
  pageCount: number
}

export type FilePart = FilePartImageOrDocument | FilePartOffice | FilePartDeck

/**
 * HOW A BUILD ENDED — three terminals, not two.
 *
 * `'stopped'` is a first-class outcome and NOT a flavour of failure. A citizen's own Stop, a
 * force-end, an idle teardown and a spent daily limit all end a build with nothing wrong, and
 * folding them into `'failed'` is exactly what announced a deliberate Stop as "The build failed:
 * stopped_by_user" (#204) — while the activity pill beside it correctly read "stopped before it
 * finished". One fact, two states, one screen.
 *
 * BOTH producers carry it, deliberately. The live turn terminal (`ConversationSurface`'s
 * `announceTerminal`) and the stored banner (`conversationApi`'s `messagesFromProjection`) each
 * used to collapse a stop into a different lie — `failed` live, `ended` on reload — so widening
 * one alone would only move the contradiction to whichever path the citizen took.
 */
export type BuildOutcomeStatus = 'ended' | 'failed' | 'stopped'

/**
 * REASON → THE SENTENCE A CITIZEN READS. The one table; there is no second copy of it.
 *
 * IT LIVES IN THIS MODULE, not on the surface that renders it, because BOTH paths need it and
 * only a leaf can serve both: the live terminal is drawn by `ConversationSurface` and the reloaded
 * one is projected by `conversationApi`, and a util cannot import a component without a cycle.
 * "Two authors for one sentence" is the documented failure this arrangement exists to prevent —
 * `docs/solutions/logic-errors/prompt-only-plain-language-guarantee-leak-2026-08-24.md` records
 * fixing one emitter only changing WHEN the wrong text appeared.
 *
 * IT MIRRORS `backend/src/services/build_sessions/outcome.py::_summary` — same four reasons, same
 * wording — because that emitter writes the durable row for legacy build sessions while this one
 * renders the turn terminal, and a transcript must not say different things about the same build
 * depending on when you looked at it.
 *
 * PLUS ONE ARM THE SERVER TABLE LACKS: `workspace_restored`. It is raised at
 * `backend/src/services/turns/engine.py:1612` — a turn that ends because the citizen's workspace
 * had to be put back from the last saved copy, which is a SUCCESSFUL restore and not a broken
 * build. #204 caught it being announced as "The build failed: workspace_restored".
 */
export const OUTCOME_COPY: Readonly<Record<string, string | undefined>> = {
  quota_exceeded: 'The build stopped: you reached your daily limit.',
  stopped_by_user: 'You stopped this build before it finished.',
  force_ended: 'This build was force-stopped before it finished, and its work was discarded.',
  idle_teardown: 'This build was stopped because it sat idle.',
  workspace_restored:
    'This build stopped so your workspace could be put back from the last saved copy. Send your message again once your workspace is back.',
}

/**
 * The one-line summary carried beside a build part. It is the message's TEXT, so it is both what
 * a plain reader sees and what the model is shown as history on the next turn — which is why it
 * states the outcome plainly rather than decoratively.
 *
 * THE REASON IS CONSULTED BEFORE THE STATUS, and that is the one ordering difference from
 * `outcome.py::_summary` — do not "restore" it to match. On the SERVER, `_terminal_status` maps a
 * Stop, a force-end and an idle reap all onto ENDED, so a FAILED status there really does mean
 * something broke and can be answered first. On the turn stream it does not: `_WriteEndedError`
 * finishes as `failed` for every named graceful end there is, quota and workspace-restore
 * included. Answering the status first is exactly what printed "The build failed: quota_exceeded"
 * at someone who had merely used up their day.
 *
 * AN UNKNOWN REASON IS NEVER INTERPOLATED. Every `reason` that reaches here is a machine token —
 * a `_WriteEndedError` reason or a session end reason, `self_heal_budget_exhausted`,
 * `wall_clock_deadline_exceeded`, `sandbox_unavailable` and the rest — and not one of them is
 * prose. So an unlisted reason gets the neutral fallback, and the human-readable detail arrives on
 * its own `error` frame (the engine emits one beside every named end), written for a citizen
 * rather than for a log. Printing the token is the defect; the fallback is the fix.
 */
export function outcomeSummary({
  status,
  reason,
}: {
  status: BuildOutcomeStatus
  reason: string | null
}): string {
  const named = reason ? OUTCOME_COPY[reason] : undefined
  if (named) return named
  if (status === 'failed') return 'The build failed.'
  if (status === 'stopped') return 'This build was stopped before it finished.'
  return 'Build finished.'
}

/** The persisted/reload `build` part (`conversationApi.js`'s `banner` projection
 * item) — the builder outcome bubble read back after a page reload. */
export interface BuildPartPersisted {
  type: 'build'
  sessionId: string
  status: BuildOutcomeStatus
  reason: string | null
  previewUrl: string | null
}

/** The live `build` part — rendered the moment a build turn ends, before any reload. Two call sites feed this: the C7
 * session-based path (carries `sessionId`) and the current turn-stream "Build
 * it" path (carries `turnId`); both otherwise produce the same fields. */
export interface BuildPartLive {
  type: 'build'
  status: BuildOutcomeStatus
  previewUrl: string | null
  endedAt: string
  snapshotCommitted: boolean | null
  reason: string | null
  sessionId?: string
  turnId?: string
}

export type BuildPart = BuildPartPersisted | BuildPartLive

/** The Build it / Keep refining card, carried with its STORED resolution state
 * (`conversationApi.js` only — reload path). */
export interface PlanOptionsPart {
  type: 'plan_options'
  item: PlanOptionsItem
}

/** A stored friendly agent step — the reload half of the build narrative
 * (`conversationApi.js` only — reload path; hidden steps are filtered before
 * this part is ever constructed). */
export interface StepPart {
  type: 'step'
  step: StepItem
}

/**
 * The agent is REASONING — and this part carries no text, by construction.
 *
 * THE STATUS-ONLY GUARANTEE IS STRUCTURAL, NOT A PROMISE. Reasoning text is technical and far
 * too much for the people who read this, so the decision is that the transcript shows THAT the
 * agent is working and never what it is working through. The server enforces the same rule at
 * the other end — reasoning is stored for the provider's next turn and is never projected,
 * never framed and never sent here — and this shape is the second wall: there is no field for
 * reasoning text to arrive in, so a later change cannot start carrying it by accident.
 *
 * THE ONLY PRODUCER IS THE LIVE SURFACE, which synthesises one at the TAIL of the streaming
 * message while the turn's `working` flag is true — the model is thinking at the end of what it
 * has written so far, and `streamingParts` records at length why pinning it to index 0 made the
 * turn jump down the screen. It has no reload counterpart on purpose: a finished turn is not
 * thinking, and a status line about a moment that has passed is noise in a transcript somebody
 * is reading tomorrow.
 */
export interface ReasoningPart {
  type: 'reasoning'
}

/** A build began and no outcome closed it yet — the durable anchor
 * (`conversationApi.js` only — reload path). */
export interface BuildInProgressPart {
  type: 'build_in_progress'
  sessionId: string
}

export type MessagePart =
  | TextPart
  | FilePart
  | BuildPart
  | PlanOptionsPart
  | StepPart
  | ReasoningPart
  | BuildInProgressPart

/** The in-memory message shape the conversation surface renders
 * (`{id, role, parts, seq}`, per `conversationApi`'s own doc comment).
 * `seq`/`createdAt` are absent on the ephemeral local welcome message. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  seq?: number
  createdAt?: string
  ephemeral?: boolean
}
