import { describe, it, expect } from 'vitest'
import { estimateTokens, truncateMessages } from '../../hooks/useClaudeAPI.js'

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
    const big = 'x'.repeat(80_000) // ~20k tokens each → 3 overflow the 50k budget
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
