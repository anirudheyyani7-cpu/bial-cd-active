import { describe, it, expect } from 'vitest'
import { validateFeedback, MAX_FEEDBACK_CHARS, MAX_PAGE_CHARS } from '../feedback.js'

describe('validateFeedback — message', () => {
  it('accepts a valid message, returning the trimmed text and page', () => {
    const r = validateFeedback({ message: '  hello world  ', page: '/chat' })
    expect(r).toEqual({ ok: true, value: { message: 'hello world', page: '/chat' } })
  })

  it('rejects a missing message', () => {
    const r = validateFeedback({ page: '/chat' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/required/i)
  })

  it('rejects a non-string message', () => {
    expect(validateFeedback({ message: 42 }).ok).toBe(false)
    expect(validateFeedback({ message: { a: 1 } }).ok).toBe(false)
    expect(validateFeedback(null).ok).toBe(false)
    expect(validateFeedback('not-an-object').ok).toBe(false)
  })

  it('rejects an empty or whitespace-only message', () => {
    expect(validateFeedback({ message: '' }).ok).toBe(false)
    expect(validateFeedback({ message: '   \n\t  ' }).ok).toBe(false)
  })

  it('accepts a message exactly at the byte cap and rejects one byte over', () => {
    expect(validateFeedback({ message: 'a'.repeat(MAX_FEEDBACK_CHARS) }).ok).toBe(true)
    expect(validateFeedback({ message: 'a'.repeat(MAX_FEEDBACK_CHARS + 1) }).ok).toBe(false)
  })

  it('measures the cap in UTF-8 BYTES, not characters (multibyte boundary)', () => {
    // 'é' is 2 bytes in UTF-8, so 2000 of them == 4000 bytes (at the cap).
    const atCap = 'é'.repeat(MAX_FEEDBACK_CHARS / 2)
    expect(validateFeedback({ message: atCap }).ok).toBe(true)
    const overCap = 'é'.repeat(MAX_FEEDBACK_CHARS / 2 + 1) // 4002 bytes
    expect(validateFeedback({ message: overCap }).ok).toBe(false)
  })

  it('trims before measuring length (surrounding whitespace does not count)', () => {
    const r = validateFeedback({ message: `   ${'a'.repeat(MAX_FEEDBACK_CHARS)}   ` })
    expect(r.ok).toBe(true)
    expect(r.value.message).toHaveLength(MAX_FEEDBACK_CHARS)
  })
})

describe('validateFeedback — page (advisory, never rejects)', () => {
  it('defaults an absent page to ""', () => {
    expect(validateFeedback({ message: 'hi' }).value.page).toBe('')
  })

  it('coerces a non-string page to "" without rejecting', () => {
    const r = validateFeedback({ message: 'hi', page: { evil: true } })
    expect(r.ok).toBe(true)
    expect(r.value.page).toBe('')
  })

  it('drops a non-path-like page (javascript:/absolute URL) to ""', () => {
    expect(validateFeedback({ message: 'hi', page: 'javascript:alert(1)' }).value.page).toBe('')
    expect(validateFeedback({ message: 'hi', page: 'https://evil.example/x' }).value.page).toBe('')
    expect(validateFeedback({ message: 'hi', page: 'chat' }).value.page).toBe('')
  })

  it('keeps a path-like page and truncates an over-long one, still ok', () => {
    expect(validateFeedback({ message: 'hi', page: '/admin/feedback' }).value.page).toBe('/admin/feedback')
    const longPath = `/${'x'.repeat(MAX_PAGE_CHARS + 50)}`
    const r = validateFeedback({ message: 'hi', page: longPath })
    expect(r.ok).toBe(true)
    expect(r.value.page).toHaveLength(MAX_PAGE_CHARS)
    expect(r.value.page.startsWith('/')).toBe(true)
  })
})
