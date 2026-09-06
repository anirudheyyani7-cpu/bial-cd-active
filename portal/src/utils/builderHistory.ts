/**
 * Builder-session store, server-backed (kind 'build'), built on the shared async factory. There
 * is no plan-kind sibling to this store: the plan chat reaches `conversationApi` directly.
 *
 * READ-ONLY NOW. This store lists a project's build chats (`loadBuilds`) and reloads one from the
 * server-side projection (`getBuild` → derived display messages). It creates nothing: a build
 * row's parentage — its project, its kind and its title — rides the FIRST TURN's own request and
 * is written inside that turn's transaction (`startTurn`'s `create` block in `turnStreamApi.ts`),
 * so a workspace refusal rolls the row back instead of leaving a titled, empty build chat in the
 * project. The `createBuild` wrapper that made the separate round trip went with it.
 * The legacy `code` header snapshot died with its column (migration 0024); code truth
 * lives in the app registry + build snapshots.
 *
 * What comes back is a `ConversationHeader` plus the projected messages — see `conversationApi.ts`
 * for both shapes.
 */
import { createConversationStore, deriveTitle } from './conversationApi'

// The old three-value ConversationKind + ask/plan/write ConversationMode collapsed into one
// two-valued ChatKind (plan | build); the server 422s on the retired 'builder' string.
const store = createConversationStore('build')

export const loadBuilds = store.loadHistory
export const getBuild = store.getConversation

export { deriveTitle }
