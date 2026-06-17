import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadHistory,
  saveHistory,
  newConversation,
  appendMessage,
  buildPromptFromHistory,
} from '../chatHistory.js'

function setUser(username) {
  localStorage.setItem('bial_user', JSON.stringify({ username }))
}

beforeEach(() => {
  localStorage.clear()
})

describe('per-user namespacing', () => {
  it("isolates buckets: alice's chats are not visible as bob", () => {
    setUser('alice')
    newConversation('alice chat')
    expect(loadHistory()).toHaveLength(1)

    setUser('bob')
    expect(loadHistory()).toHaveLength(0)

    setUser('alice')
    expect(loadHistory()).toHaveLength(1) // alice's bucket intact
  })

  it('falls back to an anon bucket with no stored user (no throw)', () => {
    expect(() => loadHistory()).not.toThrow()
    expect(loadHistory()).toEqual([])
    newConversation('anon chat')
    expect(loadHistory()).toHaveLength(1)
  })

  it('persists under the namespaced key, not the bare legacy key', () => {
    setUser('alice')
    newConversation('hi')
    expect(localStorage.getItem('bial_chat_history:alice')).toBeTruthy()
    expect(localStorage.getItem('bial_chat_history')).toBeNull()
  })
})

describe('legacy global key', () => {
  it('is deleted (not copied) on first namespaced access', () => {
    localStorage.setItem('bial_chat_history', '[{"id":"old","messages":[]}]')
    setUser('alice')
    const history = loadHistory()
    expect(history).toEqual([]) // NOT migrated into alice's bucket
    expect(localStorage.getItem('bial_chat_history')).toBeNull() // deleted
  })
})

describe('survives session clear (no wipe)', () => {
  it('a saved conversation is still present after re-login as the same user', () => {
    setUser('alice')
    newConversation('keep me')
    // Simulate clearSession (tokens/user removed) — but the user re-logs in as alice.
    localStorage.removeItem('bial_access_token')
    localStorage.removeItem('bial_refresh_token')
    setUser('alice')
    expect(loadHistory()).toHaveLength(1)
  })
})

describe('buildPromptFromHistory', () => {
  it('renders an array-content (attachment) message as text, not [object Object]', () => {
    const prompt = buildPromptFromHistory([
      {
        role: 'user',
        content: [{ type: 'image', source: {} }, { type: 'text', text: 'analyze this screenshot' }],
      },
      { role: 'assistant', content: 'Sure, here is the plan.' },
    ])
    expect(prompt).toContain('analyze this screenshot')
    expect(prompt).not.toContain('[object Object]')
  })

  it('still works with plain string content', () => {
    saveHistory([])
    const prompt = buildPromptFromHistory([
      { role: 'user', content: 'build a gate tracker' },
      { role: 'assistant', content: 'ok' },
    ])
    expect(prompt).toContain('build a gate tracker')
  })
})

describe('appendMessage', () => {
  it('appends to the active conversation within the user bucket', () => {
    setUser('alice')
    const id = newConversation('hello')
    appendMessage(id, { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-06-17T00:00:00.000Z' })
    const conv = loadHistory().find((c) => c.id === id)
    expect(conv.messages).toHaveLength(1)
  })
})
