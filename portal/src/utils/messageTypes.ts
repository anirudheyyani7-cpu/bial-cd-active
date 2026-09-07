/**
 * WHY THIS EXISTS: the shared `parts[]` message-content model every producer/consumer of a
 * chat message (`conversationApi`'s reload projection, the live turn stream, `MessageContent`'s
 * render, `attachmentStore`'s transforms) agrees on. Derived from the real construction/
 * consumption sites, not invented:
 *   - `TextPart`/`FilePart` come verbatim from the JSDoc contract atop `attachmentStore.ts`
 *     (owns the parts<->wire transform; converted since this file was written, confirming
 *     these shapes — one revision, `FilePartOffice` gained `truncationNote`).
 *   - `PlanOptionsPart`/`StepPart` wrap the already-typed `PlanOptionsItem`/`StepItem` from
 *     `turnStreamApi.ts`; both are built only by `messagesFromProjection` (reload path).
 *   - `BuildInProgressPart` likewise comes from `messagesFromProjection`.
 *
 * PRE-EXISTING INCONSISTENCY, STILL NOT FIXED: the persisted/reload `build` part (the
 * `banner` branch of `messagesFromProjection`) and the live `build` part carry different
 * field sets under the same `type:'build'` discriminant — both trace to the deleted builder
 * page, and the divergence outlived it. No consumer has ever distinguished them (every field
 * is read via optional access regardless of producer), so it was never a runtime bug.
 * `BuildPartPersisted`/`BuildPartLive` stay two distinct named types, unioned rather than
 * collapsed into one everything-optional shape, so the divergence stays legible.
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

/** The persisted/reload `build` part (`conversationApi.js`'s `banner` projection
 * item) — the builder outcome bubble read back after a page reload. */
export interface BuildPartPersisted {
  type: 'build'
  sessionId: string
  status: 'ended' | 'failed'
  reason: string | null
  previewUrl: string | null
}

/** The live `build` part — rendered the moment a build turn ends, before any reload. Two call sites feed this: the C7
 * session-based path (carries `sessionId`) and the current turn-stream "Build
 * it" path (carries `turnId`); both otherwise produce the same fields. */
export interface BuildPartLive {
  type: 'build'
  status: 'ended' | 'failed'
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
 * The agent is REASONING; carries no text, by construction — STRUCTURAL, not a promise:
 * reasoning is too technical for readers, so the transcript shows only THAT the agent works.
 * The server enforces this too (never projected here); this shape is the second wall, with
 * no field for the text to land in by accident. Synthesised only by the LIVE surface, at the
 * TAIL of a streaming message while `working` is true (see `streamingParts` on the index-0
 * jump) — no reload counterpart, since a finished turn isn't thinking.
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
