import { createConversationStore, deriveTitle } from './conversationApi.js'

// BIAL Chat (general assistant) history, server-backed (kind 'assistant'),
// isolated from App Builder's 'planning' kind so the two surfaces' recents never
// mix. Built from the same async factory as chatHistory.js — only the kind differs.
const store = createConversationStore('assistant')

export const { loadHistory, newConversation, getConversation, deleteConversation, appendMessage } = store

export { deriveTitle }

// relativeTime is presentation-only and surface-agnostic; re-export App Builder's
// so the assistant pages share one implementation.
export { relativeTime } from './chatHistory.js'
