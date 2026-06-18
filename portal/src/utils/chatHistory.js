import { contentToText } from './attachmentStore.js'
import { createConversationStore } from './conversationStore.js'

// App Builder planning-chat history. Keyed `bial_chat_history:<user>`, id prefix
// `chat`. The store logic lives in the shared factory (Decision 4) so BIAL Chat
// can mount an isolated sibling instance (assistantHistory.js) without forking
// it. Every existing import below stays valid — behaviour is byte-for-byte the
// same as the pre-factory module.
const store = createConversationStore('bial_chat_history', 'chat')

export const {
  loadHistory,
  saveHistory,
  newConversation,
  appendMessage,
  getConversation,
  deleteConversation,
} = store

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
