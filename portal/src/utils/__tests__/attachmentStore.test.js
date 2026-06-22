import { describe, it, expect, vi } from 'vitest'
import {
  partsToText,
  attachmentsFromParts,
  countAttachments,
  assembleApiMessages,
  buildUserParts,
  decodeBase64Text,
} from '../attachmentStore.js'

const b64Utf8 = (s) => Buffer.from(s, 'utf8').toString('base64')

const textAttachmentPart = (name, content) => ({
  type: 'text',
  text: content,
  attachment: { attachmentId: `${name}-id`, name, mediaType: name.endsWith('.csv') ? 'text/csv' : 'text/plain', size: content.length },
})
const imagePart = (id) => ({ type: 'file', attachmentId: id, key: `att/u/${id}`, kind: 'image', mediaType: 'image/png', name: `${id}.png`, size: 10 })

describe('partsToText', () => {
  it('joins prose text parts and ignores file + inline-attachment parts', () => {
    const parts = [imagePart('a'), textAttachmentPart('roster.csv', 'x,y'), { type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]
    expect(partsToText(parts)).toBe('hello\nworld')
  })
  it('accepts a raw string defensively', () => {
    expect(partsToText('legacy assistant text')).toBe('legacy assistant text')
  })
})

describe('attachmentsFromParts', () => {
  it('extracts file + inline-text descriptors (for AttachmentChips)', () => {
    const parts = [imagePart('img1'), textAttachmentPart('d.csv', 'a,b'), { type: 'text', text: 'caption' }]
    expect(attachmentsFromParts(parts)).toEqual([
      { attachmentId: 'img1', kind: 'image', name: 'img1.png', mediaType: 'image/png' },
      { attachmentId: 'd.csv-id', kind: 'text', name: 'd.csv', mediaType: 'text/csv' },
    ])
  })
})

describe('countAttachments', () => {
  it('sums file + inline-text attachment parts across turns', () => {
    const messages = [
      { role: 'user', parts: [imagePart('1'), textAttachmentPart('r.csv', 'a'), { type: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      { role: 'user', parts: [imagePart('2'), { type: 'text', text: 'more' }] },
    ]
    expect(countAttachments(messages)).toBe(3)
  })
  it('is 0 for empty / attachment-free / non-array', () => {
    expect(countAttachments([])).toBe(0)
    expect(countAttachments([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }])).toBe(0)
    expect(countAttachments(null)).toBe(0)
  })
})

describe('assembleApiMessages — download-free parts transform', () => {
  it('newest turn with a new image builds an image block from in-memory bytes (no historical fetch)', () => {
    const messages = [
      { role: 'user', parts: [imagePart('old'), { type: 'text', text: 'turn 1' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      { role: 'user', parts: [imagePart('new'), { type: 'text', text: 'look' }] },
    ]
    const lookups = []
    const getBytes = (id) => {
      lookups.push(id)
      return id === 'new' ? 'IMGDATA' : undefined
    }
    const out = assembleApiMessages(messages, getBytes)
    // Turn 1 (historical binary) dropped → plain string; never fetched 'old'.
    expect(out[0]).toEqual({ role: 'user', content: 'turn 1' })
    expect(out[1]).toEqual({ role: 'assistant', content: 'ok' })
    // Newest turn: image block from in-memory bytes, file before text.
    expect(out[2].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMGDATA' } })
    expect(out[2].content[1]).toEqual({ type: 'text', text: 'look' })
    expect(lookups).toEqual(['new']) // only the newest binary was looked up
  })

  it('keeps an inline text attachment STICKY across turns (no fetch), drops old images', () => {
    const messages = [
      { role: 'user', parts: [textAttachmentPart('d.csv', 'a,b\n1,2'), imagePart('img'), { type: 'text', text: 'turn 1' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      { role: 'user', parts: [{ type: 'text', text: 'turn 2' }] },
    ]
    const out = assembleApiMessages(messages, () => undefined) // no byte source at all
    // Turn 1 not newest: CSV still inlined (sticky), image gone.
    expect(Array.isArray(out[0].content)).toBe(true)
    expect(out[0].content.some((b) => b.type === 'image')).toBe(false)
    expect(out[0].content[0].text).toContain('<attachment name="d.csv" type="text">')
    expect(out[0].content[0].text).toContain('a,b\n1,2')
    expect(out[2]).toEqual({ role: 'user', content: 'turn 2' }) // plain
  })

  it('a turn with only prose → plain string content', () => {
    const out = assembleApiMessages([{ role: 'user', parts: [{ type: 'text', text: 'just text' }] }])
    expect(out[0]).toEqual({ role: 'user', content: 'just text' })
  })
})

describe('decodeBase64Text', () => {
  it('round-trips multibyte + strips a leading BOM (not bare atob)', () => {
    expect(decodeBase64Text(b64Utf8('﻿café,€,日本'))).toBe('café,€,日本')
  })
})

describe('buildUserParts', () => {
  it('inlines text attachments and uploads binaries, prose text last', async () => {
    const upload = vi.fn(async (a) => ({ attachmentId: a.attachmentId, key: `att/u/${a.attachmentId}`, kind: 'image', name: a.name, mediaType: a.mediaType, size: a.size }))
    const pending = [
      { id: 'csv1', name: 'r.csv', mediaType: 'text/csv', size: 5, base64: b64Utf8('a,b\n1') },
      { id: 'img1', name: 'p.png', mediaType: 'image/png', size: 10, base64: 'AAAA' },
    ]
    const parts = await buildUserParts('analyze these', pending, upload)
    expect(parts[0]).toEqual({ type: 'text', text: 'a,b\n1', attachment: { attachmentId: 'csv1', name: 'r.csv', mediaType: 'text/csv', size: 5 } })
    expect(parts[1]).toMatchObject({ type: 'file', attachmentId: 'img1', kind: 'image', mediaType: 'image/png' })
    expect(parts[2]).toEqual({ type: 'text', text: 'analyze these' })
    expect(upload).toHaveBeenCalledTimes(1) // only the binary uploaded
  })

  it('propagates an upload failure so the caller can abort the send', async () => {
    const upload = vi.fn(async () => {
      throw new Error('cap hit')
    })
    await expect(buildUserParts('x', [{ id: 'i', name: 'p.png', mediaType: 'image/png', size: 1, base64: 'AA' }], upload)).rejects.toThrow('cap hit')
  })
})
