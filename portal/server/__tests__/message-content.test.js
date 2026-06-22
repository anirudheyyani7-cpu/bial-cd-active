import { describe, it, expect } from 'vitest'
import {
  validateAttachmentBytes,
  validateAttachments,
  sniffMediaType,
  partsToContent,
  partsToText,
  ATTACHMENT_MAX_BYTES,
} from '../message-content.js'

// Magic-byte fixtures (base64) so validation/sniffing run against real prefixes.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).toString('base64')
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).toString('base64')
const RIFF_NOT_WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]).toString('base64')

describe('validateAttachmentBytes', () => {
  it('accepts a valid PNG / JPEG / PDF / WebP', () => {
    expect(validateAttachmentBytes({ mediaType: 'image/png', base64: PNG })).toBeNull()
    expect(validateAttachmentBytes({ mediaType: 'image/jpeg', base64: JPEG })).toBeNull()
    expect(validateAttachmentBytes({ mediaType: 'application/pdf', base64: PDF })).toBeNull()
    expect(validateAttachmentBytes({ mediaType: 'image/webp', base64: WEBP })).toBeNull()
  })

  it('rejects a non-allowlisted type, a magic mismatch, and a RIFF-not-WEBP', () => {
    expect(validateAttachmentBytes({ mediaType: 'text/csv', base64: PNG })).toMatch(/Unsupported/)
    expect(validateAttachmentBytes({ mediaType: 'image/png', base64: JPEG })).toMatch(/do not match/)
    expect(validateAttachmentBytes({ mediaType: 'image/webp', base64: RIFF_NOT_WEBP })).toMatch(/image\/webp/)
  })

  it('enforces the size cap only when size is provided', () => {
    expect(validateAttachmentBytes({ mediaType: 'image/png', base64: PNG, size: ATTACHMENT_MAX_BYTES + 1 })).toMatch(/too large/)
    expect(validateAttachmentBytes({ mediaType: 'image/png', base64: PNG, size: 1000 })).toBeNull()
    expect(validateAttachmentBytes({ mediaType: 'image/png', base64: PNG })).toBeNull() // no size → no cap (relay path)
  })
})

describe('validateAttachments (messages-shaped, /api/claude relay)', () => {
  it('passes string content and a valid image block; rejects a doc/pdf pairing mismatch', () => {
    expect(validateAttachments([{ role: 'user', content: 'plain text' }])).toBeNull()
    expect(
      validateAttachments([
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: 'hi' }] },
      ]),
    ).toBeNull()
    expect(
      validateAttachments([
        { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
      ]),
    ).toMatch(/must be a PDF/)
  })

  it('caps an oversized inline text block', () => {
    const huge = 'x'.repeat(512 * 1024 + 1)
    expect(validateAttachments([{ role: 'user', content: [{ type: 'text', text: huge }] }])).toMatch(/too large/)
  })
})

describe('sniffMediaType', () => {
  it('identifies stored bytes by magic, null for unknown', () => {
    expect(sniffMediaType(Buffer.from(PNG, 'base64'))).toBe('image/png')
    expect(sniffMediaType(Buffer.from(PDF, 'base64'))).toBe('application/pdf')
    expect(sniffMediaType(Buffer.from(WEBP, 'base64'))).toBe('image/webp')
    expect(sniffMediaType(Buffer.from(RIFF_NOT_WEBP, 'base64'))).toBeNull() // RIFF but not WEBP
    expect(sniffMediaType(Buffer.from('not-an-image'))).toBeNull()
  })
})

describe('partsToContent (parts[] → Anthropic content[])', () => {
  const imagePart = { type: 'file', attachmentId: 'a1', key: 'att/u/a1', kind: 'image', mediaType: 'image/png', name: 'x.png' }
  const getBase64 = () => PNG

  it('builds an image block from supplied bytes, files BEFORE text (newest turn)', () => {
    const content = partsToContent([imagePart, { type: 'text', text: 'what is this?' }], { binary: true, getBase64 })
    expect(Array.isArray(content)).toBe(true)
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } })
    expect(content[1]).toEqual({ type: 'text', text: 'what is this?' })
  })

  it('returns a plain string for text-only and for a historical binary turn (download-free)', () => {
    expect(partsToContent([{ type: 'text', text: 'hello' }])).toBe('hello')
    // binary=false → the file part is dropped, no getBase64 call, plain string out.
    let called = 0
    const out = partsToContent([imagePart, { type: 'text', text: 'older turn' }], {
      binary: false,
      getBase64: () => {
        called += 1
        return PNG
      },
    })
    expect(out).toBe('older turn')
    expect(called).toBe(0) // never fetched bytes
  })

  it('keeps an inline text attachment part sticky in the text', () => {
    const out = partsToContent([{ type: 'text', text: '<attachment>data</attachment>' }, { type: 'text', text: 'question' }], { binary: true, getBase64 })
    expect(out).toBe('<attachment>data</attachment>\nquestion')
  })
})

describe('partsToText', () => {
  it('joins text parts and ignores file parts', () => {
    expect(partsToText([{ type: 'file', attachmentId: 'a' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(partsToText('legacy string')).toBe('legacy string')
  })
})
