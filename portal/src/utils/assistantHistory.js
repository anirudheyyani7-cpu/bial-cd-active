import { createConversationStore } from './conversationStore.js'

// BIAL Chat (general assistant) history. A per-user store keyed
// `bial_assistant_history:<user>`, id prefix `bchat`, isolated from App Builder's
// `bial_chat_history` so the two surfaces' recents never mix (Decision 8). Built
// from the same factory as chatHistory.js — only the prefixes differ.
const store = createConversationStore('bial_assistant_history', 'bchat')

export const {
  loadHistory,
  saveHistory,
  newConversation,
  appendMessage,
  getConversation,
  deleteConversation,
} = store

// relativeTime is presentation-only and surface-agnostic; re-export App Builder's
// so the assistant pages share one implementation.
export { relativeTime } from './chatHistory.js'
