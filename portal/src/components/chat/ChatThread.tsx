/**
 * THE TRANSCRIPT — the portal's composition of the ported thread. One surface for both
 * chat kinds: nothing here consults kind, so a Plan transcript cannot show a build (no
 * build parts ever arrive in it) — a test asserts identical DOM either way. It mounts
 * into `ConversationSlot`, which owns height/hide (no `calc(100vh - …)` here); the
 * runtime lives at the SURFACE, not here, so the composer can share it via `useAui()`.
 *
 * `MessageContent` is RE-HOSTED, not replaced: it holds four guarantees —
 * `disallowedElements` (this repo's only `img-src` protection), the CSV-injection
 * control, `remark-breaks`, and the `mode="static"` guard — that
 * `@assistant-ui/react-markdown` lacks; its 21-case parity checklist must pass first.
 */
import { useMemo, type FC } from 'react'

import { Thread, type ThreadComponents } from '../assistant-ui/thread'
import MessageContent from './MessageContent'
import AttachmentChips from '../AttachmentChips'
import ActivityGroup, { InterruptedMessagesContext, GroupSealedContext } from './ActivityGroup'
import ActivityRow from './ActivityRow'

export interface ChatThreadProps {
  /**
   * Messages whose turn ended on an interrupted terminal. Supplied by the surface because
   * it is a fact about the turn, not about any part.
   */
  interruptedMessageIds?: ReadonlySet<string>
  /** Rendered under the viewport — the composer, the offer strip, the return-to-latest control. */
  footer?: FC | undefined
  /** Told what an activity group amounted to as it seals. */
  onGroupSealed?: ((summary: string) => void) | undefined
}

/**
 * The text part, rendered by the portal's own renderer.
 *
 * `isUser` keeps user prose VERBATIM — markdown is never parsed in a user message, so a citizen
 * who types `**` sees `**`. That is a safety guarantee, not a style choice, and it is one of the
 * 21 parity cases.
 */
const TextPart: ThreadComponents['TextPart'] = ({ text, isUser }) => (
  <MessageContent parts={text} isUser={isUser} />
)

/**
 * THE WORKING STATUS — status only, never the reasoning content (too technical here;
 * `useMessagePartReasoning` unused): a narrow exception to no-indicator-without-tools,
 * driven by the model's real reasoning signal, not TURN STATUS (once shown on every
 * message) — gone the instant writing or a call starts. ALSO APPEARS ON A TOOL-RUNNING
 * TURN: grouping is HIERARCHICAL, `reasoning` and `tool-call` sharing
 * `group-chainOfThought` but rendering separate children, so a build shows status first.
 */
const ReasoningGroup: ThreadComponents['ReasoningGroup'] = () => (
  <p data-testid="working-status" className="my-1 text-xs text-neutral">
    Working on your app
  </p>
)

const noAnnouncement = () => {}

const ChatThread: FC<ChatThreadProps> = ({ interruptedMessageIds, footer, onGroupSealed }) => {
  const components = useMemo<ThreadComponents>(
    () => ({
      TextPart,
      UserAttachments: AttachmentChips,
      ToolGroup: ActivityGroup,
      ToolPart: ActivityRow,
      ReasoningGroup,
      ViewportFooter: footer,
    }),
    [footer],
  )

  const interrupted = useMemo(
    () => interruptedMessageIds ?? new Set<string>(),
    [interruptedMessageIds],
  )

  // A stable identity for the default, so a surface that passes nothing does not hand the groups a
  // new callback on every render and re-run their announce effect.
  const announceSealed = useMemo(() => onGroupSealed ?? noAnnouncement, [onGroupSealed])

  return (
    <InterruptedMessagesContext.Provider value={interrupted}>
      <GroupSealedContext.Provider value={announceSealed}>
        <Thread components={components} />
      </GroupSealedContext.Provider>
    </InterruptedMessagesContext.Provider>
  )
}

export default ChatThread
