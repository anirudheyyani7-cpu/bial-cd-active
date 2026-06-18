import { getStoredUser } from './auth.js'
import { deleteAttachment } from './attachmentStore.js'

/**
 * Factory for a per-user conversation store backed by localStorage. Two chat
 * surfaces (App Builder planning chat, BIAL Chat) each get an isolated instance
 * keyed by a distinct `prefix`, so their recents never mix — the bodies are
 * identical, only the storage prefix and id prefix differ.
 *
 * Conversations are namespaced per user (`${prefix}:${username}`) so switching
 * accounts shows the right chats. The pre-namespacing global key is exactly the
 * prefix (no `:user` suffix); it is deleted — not migrated — on first load, so a
 * shared-terminal global bucket can't be attributed to whoever logs in first.
 *
 * Only lightweight attachment refs live in the conversation; the bytes live in
 * attachmentStore (IndexedDB). deleteConversation frees those bytes so deleting
 * a chat reclaims its space (best-effort, fire-and-forget).
 */
export function createConversationStore(prefix, idPrefix) {
  const legacyGlobalKey = prefix
  const storageKey = () => `${prefix}:${getStoredUser()?.username || '__anon__'}`

  function loadHistory() {
    try {
      // Guard with an existence check so the removeItem write fires only when the
      // legacy key is actually present (this runs inside every append round-trip).
      if (localStorage.getItem(legacyGlobalKey) !== null) {
        localStorage.removeItem(legacyGlobalKey)
      }
      const raw = localStorage.getItem(storageKey())
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }

  function saveHistory(conversations) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(conversations))
    } catch {
      // storage full / unavailable — best-effort, mirrors builderHistory.saveBuilds.
    }
  }

  function newConversation(firstMessage) {
    const id = `${idPrefix}_${Date.now()}`
    const title = firstMessage.trim().slice(0, 40) + (firstMessage.trim().length > 40 ? '…' : '')
    const now = new Date().toISOString()
    const conversation = { id, title, createdAt: now, updatedAt: now, messages: [] }
    saveHistory([conversation, ...loadHistory()])
    return id
  }

  function appendMessage(chatId, message) {
    const updated = loadHistory().map((c) => {
      if (c.id !== chatId) return c
      return { ...c, updatedAt: new Date().toISOString(), messages: [...c.messages, message] }
    })
    saveHistory(updated)
  }

  function getConversation(chatId) {
    return loadHistory().find((c) => c.id === chatId) || null
  }

  function deleteConversation(chatId) {
    const conv = getConversation(chatId)
    // Free this conversation's attachment bytes so the per-user IndexedDB store
    // (and its running-total cap) isn't a one-way ratchet. Best-effort.
    conv?.messages.forEach((m) => m.attachments?.forEach((a) => deleteAttachment(a.id)))
    saveHistory(loadHistory().filter((c) => c.id !== chatId))
  }

  return { loadHistory, saveHistory, newConversation, appendMessage, getConversation, deleteConversation }
}
