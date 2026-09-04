/**
 * ONE SLOT FOR THE MOUNTED CONVERSATION. It owns four things and no more.
 *
 * WHICH BODY renders: one `ConversationSurface` for both kinds, with `kind` passed through.
 * WHETHER IT IS VISIBLE: the hide treatment is applied here and defined in `hiddenSubtree.ts`,
 * because the chat-panel collapse is its other caller and a page importing this slot would close a
 * cycle. THE DRAFT: both kinds share `utils/composerDraft.ts` — `sessionStorage`, keyed per
 * conversation, cleared only on a successful send, where the planning composer used to lose its
 * text on a reload. NOTHING ELSE: transport, transcript and attachments live on the surface, and
 * the router still decides which conversation is mounted — this slot keeps no stack alive, so a
 * project↔chat move unmounts the conversation and only the draft and the app pane survive it.
 */
import ConversationSurface from '../chat/ConversationSurface'
import type { ChatKind } from '../../pages/ChatRoute'
import { HIDDEN_BUT_MOUNTED } from './hiddenSubtree'

/** What `ChatRoute` resolved: which conversation, of which kind, in which project. */
export interface MountedConversation {
  chatId: string
  kind: ChatKind
  projectId: string | null
  projectName: string | null
  projectHasSavedBuild: boolean | null
}

interface Props {
  conversation: MountedConversation
  /** Passed through to the surface — see `ConversationSurfaceProps.onTitleDerived`. */
  onTitleDerived?: (title: string) => void
  /**
   * Hide the conversation without discarding it. No caller in this plan sets it — the builder
   * surface's own chat-panel collapse hides a panel, not the whole conversation, and Plan F's rail
   * modes are the first real caller. It exists here so that when they arrive there is one hide
   * with the reasoning already attached, rather than a second one invented next to it.
   */
  hidden?: boolean
}

export default function ConversationSlot({ conversation, hidden = false, onTitleDerived }: Props) {
  // `kind` is read for one thing only: whether the surface declares the app pane visible. What a
  // turn may do to the app is the server toolset's decision — see `ConversationCreateRequest.kind`.
  const { chatId, kind, projectId, projectName, projectHasSavedBuild } = conversation
  const shared = { chatId, projectId, projectName }

  return (
    <div
      data-testid="conversation-slot"
      aria-hidden={hidden}
      className={`flex-1 min-h-0 flex flex-col overflow-hidden ${hidden ? HIDDEN_BUT_MOUNTED : ''}`}
    >
      <ConversationSurface
        {...shared}
        kind={kind}
        projectHasSavedBuild={projectHasSavedBuild}
        onTitleDerived={onTitleDerived}
      />
    </div>
  )
}
