/**
 * THE RUNTIME — the single junction between the stream reader, the reload projection and every
 * rendered element.
 *
 * `useExternalStoreRuntime`, deliberately, and not `useLocalRuntime` or the AI-SDK runtime: those
 * two OWN the message array and mint ids. The reverted migration's lesson stands — the library is
 * a render model, and the hydrated server transcript is the truth for ordering, identity and
 * history. Everything this hook passes is read-only from the library's point of view.
 *
 * ══ EVERY CAPABILITY IS OFF BY OMISSION, EXCEPT THREE ══
 *
 * A capability in this library is not a setting you switch off. It is DERIVED from which callbacks
 * and adapters you hand over, which means the way to keep one off is to pass nothing — and the way
 * one wakes up by accident is somebody adding a callback to fix an unrelated problem. Verified
 * derivations, read out of the installed 0.15.17:
 *
 *   switchToBranch, delete        ← `setMessages`      (ONE prop, TWO capabilities)
 *   edit, reload, refetchThread   ← onEdit / onReload / onRefetchThread
 *   cancel                        ← onCancel                          ← WE PASS THIS
 *   speech, dictation, voice,
 *   attachments, feedback         ← adapters.*      ← WE PASS `attachments`
 *   queue                         ← queue
 *   unstable_copy                 ← unstable_capabilities.copy (default true)
 *
 * `cancel` is the one capability this surface WANTS: registering `onCancel` is what puts the
 * relocated stop on the runtime. `unstable_copy` is passed explicitly even though `true` is already
 * the default, so the intent is legible and a future change of default shows up in a diff rather
 * than in production.
 *
 * THE WRITTEN LIST HAS THREE `true` ENTRIES. Anyone writing the exact-equality test from a shorter
 * sentence — "everything off except copy" — gets a red suite, and the tempting fix is to drop
 * `onCancel`, which silently deletes the stop path. `EXPECTED_CAPABILITIES` below is the list, the
 * test compares against it with `toEqual`, and this paragraph is why.
 */
import { useMemo } from 'react'
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type AttachmentAdapter,
} from '@assistant-ui/react'

import type { ChatMessage } from '../../../utils/messageTypes'
import { assertUniqueIds, convertMessage } from './convertMessage'

/**
 * THE CAPABILITY LIST, written down.
 *
 * Fourteen keys, matching `RuntimeCapabilities` exactly, and THREE of them are `true`. A test
 * compares `runtime.thread.getState().capabilities` against this with `toEqual` — exact equality,
 * never `toMatchObject`, because `toMatchObject` passes when a capability we never listed wakes
 * up, which is the entire failure this guard exists to catch.
 */
export const EXPECTED_CAPABILITIES = {
  // ── the three we want ──
  /** Registered by passing `onCancel`; dropping it deletes the stop path. */
  cancel: true,
  /** Explicit though it is the default, so a change of default is visible in a diff. */
  unstable_copy: true,
  /**
   * ON, AND IT HAD TO BE. The library's add-attachment control, its chip list and its dropzone
   * are ALL gated on this capability — with it off they render nothing, so there is no way to
   * adopt the library's box and keep it off. The adapter behind it wraps THIS project's own
   * pipeline: the library renders a chip, it does not decide which content is re-sent, which
   * binaries are inlined, the cache-breakpoint ceiling, or how fences are escaped.
   * See `attachmentAdapter.ts`, which also records why the library's `send` is not on our path.
   */
  attachments: true,

  // ── the eleven that stay off, by passing nothing ──
  switchToBranch: false,
  switchBranchDuringRun: false,
  edit: false,
  reload: false,
  refetchThread: false,
  delete: false,
  speech: false,
  dictation: false,
  voice: false,
  feedback: false,
  queue: false,
} as const

export interface ChatRuntimeOptions {
  /**
   * The transcript, server-owned. Both the live assembly and the reload projection produce this
   * same shape, which is what makes them render identically.
   */
  messages: readonly ChatMessage[]
  /**
   * Flows straight to `thread.isRunning`. ONE field replaces the several per-page booleans that
   * used to decide whether a spinner drew.
   *
   * Omitting it is not neutral: `thread.isRunning` then falls back to a last-message-status
   * heuristic over `messages`, which is a different question with a different answer.
   */
  isRunning: boolean
  /** Send. The library never owns this path — it hands us the composed message and stops. */
  onNew: (message: AppendMessage) => Promise<void>
  /** The relocated stop. Passing it is what registers `cancel`. */
  onCancel: () => Promise<void>
  /** The attachment adapter over this project's own pipeline. Passing it registers `attachments`. */
  attachments: AttachmentAdapter
}

export function useChatRuntime({
  messages,
  isRunning,
  onNew,
  onCancel,
  attachments,
}: ChatRuntimeOptions): AssistantRuntime {
  // Fail loudly on a duplicate id BEFORE the runtime sees the array. Its own behaviour is to keep
  // the last occurrence and `console.warn`, which costs a whole turn and reports it nowhere
  // anyone is looking.
  //
  // Memoised on the array identity, not on a deep compare: the streaming path already produces a
  // new array per update (and a new object only for the message that changed — see convertMessage
  // trap 4), so array identity is exactly the right cache key and a deep compare would be paying
  // for a guarantee the caller already provides.
  useMemo(() => assertUniqueIds(messages), [messages])

  return useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning,
    onNew,
    onCancel,
    convertMessage,
    unstable_capabilities: { copy: true },
    adapters: { attachments },

    // ── DELIBERATELY ABSENT, and each absence is a capability ──
    //
    // setMessages     — switches on BOTH `switchToBranch` and `delete`. The most likely accidental
    //                   addition on this list: it is what someone reaches for to "fix a rerender".
    // onEdit          — `edit`. No message editing on this surface.
    // onReload        — `reload`. No regenerate.
    // onRefetchThread — `refetchThread`.
    // queue           — `queue`. Never registered: there is no queued send here, and the Send
    //                   this surface renders is `ComposerBox`'s own, not the library's.
    // adapters        — `speech`, `dictation`, `voice` and `feedback` stay absent. `attachments`
    //                   is now PASSED, and the reason it is safe to pass is that the adapter is
    //                   ours: the library renders a chip, it does not decide which content is
    //                   re-sent, which binaries are inlined, the cache-breakpoint ceiling, or how
    //                   fences are escaped.
    // isSendDisabled  — unwired: it gates the library's own Send, and Send here is ours, so
    //                   nothing executes the path it guards.
    // unstable_enableToolInvocations — would run tool callbacks TWICE on top of our own step
    //                   dispatch. Its default is already `false`; naming it here is documentation,
    //                   not configuration.
  })
}
