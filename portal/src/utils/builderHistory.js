/**
 * Builder-session store, now server-backed (kind 'builder'). Mirrors
 * chatHistory.js via the shared async factory; the generated app code rides on
 * the conversation header as `code.current` (patched with patchBuildCode), so a
 * reopened build renders from a single point read — no transcript scan.
 *
 * A build header is `{ id, title, createdAt, updatedAt, context, code }`:
 *   - context: generation settings (dataSource/theme/hasSchema/uploadedFiles),
 *     passed via the first appendBuilderMessage's header so refinements after a
 *     resume keep their configuration.
 *   - code.current: the latest extracted PreviewApp snapshot.
 * Messages are REAL turns only (user + assistant result); the caller excludes
 * ephemeral stage/welcome bubbles before persisting.
 *
 * Names are unchanged from the localStorage version; loadBuilds/getBuild/
 * appendBuilderMessage/deleteBuild are now async; newBuild stays synchronous.
 */
import { createConversationStore, patchConversation, deriveTitle } from './conversationApi.js'

const store = createConversationStore('builder')

export const loadBuilds = store.loadHistory
export const newBuild = store.newConversation // sync UUID; header created on first append
export const getBuild = store.getConversation
export const deleteBuild = store.deleteConversation
export const appendBuilderMessage = store.appendMessage // (id, message, header)

/** Persist the latest generated code snapshot on the build header. */
export function patchBuildCode(id, codeCurrent, deps) {
  return patchConversation(id, { code: codeCurrent }, deps)
}

export { deriveTitle }
