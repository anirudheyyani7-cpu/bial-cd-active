import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  truncateMessages,
  estimateConversationTokens,
  CONTEXT_SOFT_LIMIT,
  CONTEXT_HARD_LIMIT,
} from '../../hooks/useClaudeAPI.js'

describe('estimateTokens', () => {
  it('handles a mix of string and array content without throwing', () => {
    const messages = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi there' },
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4_000_000) } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ]
    const n = estimateTokens(messages)
    expect(typeof n).toBe('number')
    expect(Number.isFinite(n)).toBe(true)
  })

  it('estimates an array message by a flat nominal file cost, not element count or base64 length', () => {
    const bigImage = {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4_000_000) } }],
    }
    const est = estimateTokens([bigImage])
    expect(est).toBeGreaterThanOrEqual(1_000) // not ~1 (element count) or ~2 (decoded size)
    expect(est).toBeLessThan(10_000) // not ~1,000,000 (raw base64 length / 4)
  })
})

describe('truncateMessages', () => {
  it('trims the oldest middle messages when over budget and keeps the first + newest turn', () => {
    const big = 'x'.repeat(300_000) // ~75k tokens each → 3 overflow the 180k backstop budget
    const newest = { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'NEWEST' }] }
    const messages = [
      { role: 'user', content: 'FIRST' },
      { role: 'assistant', content: big },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      newest,
    ]
    const out = truncateMessages(messages)
    expect(out[0].content).toBe('FIRST') // first preserved
    expect(out[out.length - 1]).toEqual(newest) // newest (attachment) turn preserved
    expect(out.length).toBeLessThan(messages.length) // at least one oldest-middle dropped
  })
})

describe('estimateConversationTokens', () => {
  it('counts message text + system prompt + the newest turn\'s attachments', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(400) }, // 100 tokens
      { role: 'assistant', content: 'b'.repeat(400) }, // 100 tokens
      { role: 'user', content: 'c'.repeat(400), attachments: [{ id: '1' }, { id: '2' }] }, // 100 + 2 files
    ]
    const system = 's'.repeat(2000) // 500 tokens
    const est = estimateConversationTokens(messages, system)
    // 300 (text) + 500 (system) + 2 * 1600 (nominal per last-turn attachment) = 4000
    expect(est).toBe(4000)
  })

  it('does not count attachments on non-final turns (they send text-only)', () => {
    const withOldAttach = [
      { role: 'user', content: '', attachments: [{ id: '1' }, { id: '2' }, { id: '3' }] },
      { role: 'assistant', content: '' },
    ]
    // only text (0) + system (0) + last turn has no attachments → 0
    expect(estimateConversationTokens(withOldAttach, '')).toBe(0)
  })

  it('is empty-safe and exposes ordered thresholds', () => {
    expect(estimateConversationTokens([], '')).toBe(0)
    expect(estimateConversationTokens(null, '')).toBe(0)
    expect(CONTEXT_SOFT_LIMIT).toBeLessThan(CONTEXT_HARD_LIMIT)
  })
})
