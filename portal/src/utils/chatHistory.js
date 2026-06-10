const STORAGE_KEY = 'bial_chat_history'

export function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveHistory(conversations) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
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
  const goal = userMessages[0]?.content || ''

  const contextMessages = messages.slice(-10)
  const transcript = contextMessages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
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
