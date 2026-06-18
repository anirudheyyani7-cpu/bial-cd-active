import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the byte store so deleteConversation's cleanup is observable without
// IndexedDB. createConversationStore only depends on deleteAttachment here.
const deleteAttachment = vi.fn()
vi.mock('../attachmentStore.js', () => ({ deleteAttachment: (...a) => deleteAttachment(...a) }))

import { createConversationStore } from '../conversationStore.js'

function setUser(username) {
  localStorage.setItem('bial_user', JSON.stringify({ username }))
}

beforeEach(() => {
  localStorage.clear()
  deleteAttachment.mockClear()
})

describe('createConversationStore — isolation', () => {
  it('two stores with distinct prefixes never see each other’s conversations', () => {
    const a = createConversationStore('bial_chat_history', 'chat')
    const b = createConversationStore('bial_assistant_history', 'bchat')
    setUser('alice')
    a.newConversation('planning chat')
    expect(a.loadHistory()).toHaveLength(1)
    expect(b.loadHistory()).toHaveLength(0) // store B is empty

    b.newConversation('assistant chat')
    expect(b.loadHistory()).toHaveLength(1)
    expect(a.loadHistory()).toHaveLength(1) // store A unchanged
    // Distinct localStorage keys back each store.
    expect(localStorage.getItem('bial_chat_history:alice')).toBeTruthy()
    expect(localStorage.getItem('bial_assistant_history:alice')).toBeTruthy()
  })

  it('uses the configured idPrefix for new conversation ids', () => {
    const b = createConversationStore('bial_assistant_history', 'bchat')
    setUser('alice')
    const id = b.newConversation('hi')
    expect(id.startsWith('bchat_')).toBe(true)
  })
})

describe('createConversationStore — roundtrip + append', () => {
  it('newConversation → getConversation roundtrips; appendMessage appends and bumps updatedAt', () => {
    const store = createConversationStore('bial_assistant_history', 'bchat')
    setUser('alice')
    const id = store.newConversation('first message that is long enough to be truncated past forty chars total')
    const created = store.getConversation(id)
    expect(created).toBeTruthy()
    expect(created.title.endsWith('…')).toBe(true) // title truncated at 40
    expect(created.messages).toHaveLength(0)
    const before = created.updatedAt

    store.appendMessage(id, { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-06-18T00:00:00.000Z' })
    const after = store.getConversation(id)
    expect(after.messages).toHaveLength(1)
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime())
  })
})

describe('createConversationStore — delete frees attachment bytes', () => {
  it('deleteConversation removes the conversation and deletes each attachment ref', () => {
    const store = createConversationStore('bial_assistant_history', 'bchat')
    setUser('alice')
    const id = store.newConversation('with files')
    store.appendMessage(id, {
      id: 'm1', role: 'user', content: 'see these',
      attachments: [{ id: 'att_1' }, { id: 'att_2' }],
    })
    store.deleteConversation(id)
    expect(store.getConversation(id)).toBeNull()
    expect(deleteAttachment).toHaveBeenCalledWith('att_1')
    expect(deleteAttachment).toHaveBeenCalledWith('att_2')
  })
})

describe('createConversationStore — per-user namespacing', () => {
  it('switching the stored user changes which bucket is read', () => {
    const store = createConversationStore('bial_assistant_history', 'bchat')
    setUser('alice')
    store.newConversation('alice chat')
    expect(store.loadHistory()).toHaveLength(1)

    setUser('bob')
    expect(store.loadHistory()).toHaveLength(0)

    setUser('alice')
    expect(store.loadHistory()).toHaveLength(1)
  })

  it('purges the legacy global key (equal to the prefix) on first loadHistory, without migrating it', () => {
    localStorage.setItem('bial_assistant_history', '[{"id":"old","messages":[]}]')
    const store = createConversationStore('bial_assistant_history', 'bchat')
    setUser('alice')
    expect(store.loadHistory()).toEqual([]) // NOT migrated into alice's bucket
    expect(localStorage.getItem('bial_assistant_history')).toBeNull() // deleted
  })
})
