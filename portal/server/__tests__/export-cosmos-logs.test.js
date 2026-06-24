import { describe, it, expect } from 'vitest'
import {
  parseLast,
  istDay,
  istFormat,
  flattenParts,
  resolveWindow,
} from '../../scripts/export-cosmos-logs.js'

describe('parseLast', () => {
  it('parses hours / days / weeks (case-insensitive)', () => {
    expect(parseLast('24h')).toBe(24 * 3_600_000)
    expect(parseLast('7d')).toBe(7 * 86_400_000)
    expect(parseLast('1w')).toBe(604_800_000)
    expect(parseLast('2D')).toBe(2 * 86_400_000)
  })

  it('rejects malformed specs', () => {
    expect(() => parseLast('soon')).toThrow()
    expect(() => parseLast('7')).toThrow()
    expect(() => parseLast('7m')).toThrow()
  })
})

describe('istDay / istFormat', () => {
  it('maps an instant to its IST (UTC+5:30) calendar day', () => {
    // 18:30Z is exactly 00:00 IST the next day → the day rolls over.
    expect(istDay(new Date('2026-06-23T19:00:00Z'))).toBe('2026-06-24')
    expect(istDay(new Date('2026-06-23T18:00:00Z'))).toBe('2026-06-23')
  })

  it('formats a stored ISO string in IST and tags it', () => {
    const out = istFormat('2026-06-23T18:30:00Z') // = 2026-06-24 00:00:00 IST
    expect(out).toContain('2026-06-24')
    expect(out).toContain('00:00:00')
    expect(out).toContain('IST')
  })

  it('is empty for missing values and passes unparseable values through', () => {
    expect(istFormat('')).toBe('')
    expect(istFormat(null)).toBe('')
    expect(istFormat('not-a-date')).toBe('not-a-date')
  })
})

describe('flattenParts', () => {
  it('joins text parts by newline and summarizes file parts separately', () => {
    const { text, attachments } = flattenParts([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
      { type: 'file', name: 'a.png', mediaType: 'image/png', size: 12 },
    ])
    expect(text).toBe('hello\nworld')
    expect(attachments).toBe('a.png (image/png, 12 bytes)')
  })

  it('tolerates non-array / empty input', () => {
    expect(flattenParts(undefined)).toEqual({ text: '', attachments: '' })
    expect(flattenParts([])).toEqual({ text: '', attachments: '' })
  })
})

describe('resolveWindow', () => {
  const NOW = new Date('2026-06-24T12:00:00Z')

  it('defaults to a rolling last-7-days window when no date option is given', () => {
    const w = resolveWindow({}, NOW)
    expect(w.toExclusiveInstant).toEqual(NOW)
    expect(w.fromInstant).toEqual(new Date(NOW.getTime() - 7 * 86_400_000))
    expect(w.label).toBe('last-7d')
  })

  it('honors --last as a rolling window ending now', () => {
    const w = resolveWindow({ last: '24h' }, NOW)
    expect(w.fromInstant).toEqual(new Date(NOW.getTime() - 86_400_000))
    expect(w.label).toBe('last-24h')
  })

  it('treats --from/--to as inclusive IST calendar days', () => {
    const w = resolveWindow({ from: '2026-06-01', to: '2026-06-02' }, NOW)
    expect(w.fromInstant.toISOString()).toBe('2026-05-31T18:30:00.000Z') // 2026-06-01 00:00 IST
    expect(w.toExclusiveInstant.toISOString()).toBe('2026-06-02T18:30:00.000Z') // end of 2026-06-02 IST
    expect(w.fromDay).toBe('2026-06-01')
    expect(w.toDay).toBe('2026-06-02')
    expect(w.label).toBe('2026-06-01_to_2026-06-02')
  })

  it('supports --date as a single-day shorthand', () => {
    const w = resolveWindow({ date: '2026-06-17' }, NOW)
    expect(w.fromDay).toBe('2026-06-17')
    expect(w.toDay).toBe('2026-06-17')
    expect(w.label).toBe('2026-06-17')
  })

  it('rejects an inverted range and malformed dates', () => {
    expect(() => resolveWindow({ from: '2026-06-10', to: '2026-06-01' }, NOW)).toThrow()
    expect(() => resolveWindow({ from: 'June 1' }, NOW)).toThrow()
  })
})
