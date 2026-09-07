/**
 * Builder-session store, server-backed (kind 'build'), built on the shared async factory. No
 * plan-kind sibling: the plan chat reaches `conversationApi` directly.
 *
 * READ-ONLY NOW: lists a project's build chats (`loadBuilds`) and reloads one from the
 * server-side projection (`getBuild`). Creates nothing — a build row's parentage rides the
 * FIRST TURN's own request and is written inside that turn's transaction (`startTurn`'s
 * `create` block in `turnStreamApi.ts`), so a workspace refusal rolls the row back instead of
 * leaving a titled, empty chat behind. See `conversationApi.ts` for the returned shapes.
 */
import { createConversationStore, deriveTitle } from './conversationApi'

// The old three-value ConversationKind + ask/plan/write ConversationMode collapsed into one
// two-valued ChatKind (plan | build); the server 422s on the retired 'builder' string.
const store = createConversationStore('build')

export const loadBuilds = store.loadHistory
export const getBuild = store.getConversation

export { deriveTitle }
