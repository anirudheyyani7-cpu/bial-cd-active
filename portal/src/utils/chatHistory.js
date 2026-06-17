import { getStoredUser } from './auth.js'
import { contentToText } from './attachmentStore.js'

// Conversations are namespaced per user so switching accounts shows the right
// chats. The pre-namespacing global key is exactly the prefix (no `:user`
// suffix); it is deleted — not migrated — on first load (plan Decision 8).
const STORAGE_KEY_PREFIX = 'bial_chat_history'
const LEGACY_GLOBAL_KEY = STORAGE_KEY_PREFIX

function storageKey() {
  const username = getStoredUser()?.username || '__anon__'
  return `${STORAGE_KEY_PREFIX}:${username}`
}

export function loadHistory() {
  try {
    // Abandon the legacy shared-terminal global bucket: migrating it would
    // attribute multiple prior users' chats to whoever logs in first.
    localStorage.removeItem(LEGACY_GLOBAL_KEY)
    const raw = localStorage.getItem(storageKey())
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveHistory(conversations) {
  localStorage.setItem(storageKey(), JSON.stringify(conversations))
}

export function newConversation(firstMessage) {
  const id = `chat_${Date.now()}`
  const title = firstMessage.trim().slice(0, 40) + (firstMessage.trim().length > 40 ? '…' : '')
  const now = new Date().toISOString()
  const conversation = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  const history = loadHistory()
  saveHistory([conversation, ...history])
  return id
}

export function appendMessage(chatId, message) {
  const history = loadHistory()
  const updated = history.map((c) => {
    if (c.id !== chatId) return c
    return {
      ...c,
      updatedAt: new Date().toISOString(),
      messages: [...c.messages, message],
    }
  })
  saveHistory(updated)
}

export function getConversation(chatId) {
  return loadHistory().find((c) => c.id === chatId) || null
}

export function deleteConversation(chatId) {
  saveHistory(loadHistory().filter((c) => c.id !== chatId))
}

export function buildPromptFromHistory(messages) {
  const userMessages = messages.filter((m) => m.role === 'user')
  // contentToText so an attachment turn (ContentBlock[]) yields its text, not
  // "[object Object]", in the Builder handoff transcript.
  const goal = contentToText(userMessages[0]?.content ?? '')

  const contextMessages = messages.slice(-10)
  const transcript = contextMessages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${contentToText(m.content)}`)
    .join('\n\n')

  return `Based on the following planning conversation, build the described application:

User's goal: ${goal}

Planning session:
${transcript}

Build this app based on the planning session above. Incorporate all the features and requirements discussed.`
}

export function relativeTime(isoString) {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
