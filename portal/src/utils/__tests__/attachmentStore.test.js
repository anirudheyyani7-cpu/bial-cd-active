import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  putAttachment,
  getAttachment,
  deleteAttachment,
  getTotalSize,
  clearForUser,
  buildContentBlocks,
  contentToText,
  assembleApiMessages,
  countAttachments,
  AttachmentCapError,
} from '../attachmentStore.js'

function setUser(username) {
  localStorage.setItem('bial_user', JSON.stringify({ username }))
}

// Tests share the fake-indexeddb singleton, so each uses distinct users/ids.
beforeEach(() => {
  localStorage.clear()
})

describe('attachmentStore — bytes', () => {
  it('put then get round-trips the exact base64', async () => {
    setUser('rt@x')
    await putAttachment({ id: 'a1', base64: 'QUJD', mediaType: 'image/png', size: 3 })
    expect(await getAttachment('a1')).toBe('QUJD')
  })

  it('getAttachment on an unknown id returns null; deleteAttachment removes a stored one', async () => {
    setUser('del@x')
    expect(await getAttachment('nope')).toBeNull()
    await putAttachment({ id: 'd1', base64: 'WA==', mediaType: 'image/png', size: 2 })
    expect(await getAttachment('d1')).toBe('WA==')
    await deleteAttachment('d1')
    expect(await getAttachment('d1')).toBeNull()
  })

  it('exceeding the total cap rejects with AttachmentCapError; store + total unchanged', async () => {
    setUser('cap@x')
    const CAP = 50 * 1024 * 1024
    // `size` is a logical byte count, decoupled from the tiny base64 we store —
    // lets us exercise the 50 MB cap without allocating 50 MB of data.
    await putAttachment({ id: 'c1', base64: 'AA==', mediaType: 'image/png', size: CAP })
    expect(await getTotalSize('cap@x')).toBe(CAP)

    await expect(
      putAttachment({ id: 'c2', base64: 'BB==', mediaType: 'image/png', size: 1 }),
    ).rejects.toBeInstanceOf(AttachmentCapError)

    expect(await getAttachment('c2')).toBeNull() // not stored
    expect(await getTotalSize('cap@x')).toBe(CAP) // unchanged
  })

  it('does not double-count the running total when the same id is re-put', async () => {
    setUser('reput@x')
    await putAttachment({ id: 'r1', base64: 'AA==', mediaType: 'image/png', size: 100 })
    expect(await getTotalSize('reput@x')).toBe(100)
    // Re-put the same id (overwrite, no new storage) — total must stay at the delta.
    await putAttachment({ id: 'r1', base64: 'BB==', mediaType: 'image/png', size: 100 })
    expect(await getTotalSize('reput@x')).toBe(100)
    // Re-put with a larger size adjusts by the difference only.
    await putAttachment({ id: 'r1', base64: 'CC==', mediaType: 'image/png', size: 150 })
    expect(await getTotalSize('reput@x')).toBe(150)
  })

  it('maintains an O(1) running total across put/delete and isolates it per user', async () => {
    setUser('alice@x')
    await putAttachment({ id: 'al1', base64: 'AA==', mediaType: 'image/png', size: 100 })
    await putAttachment({ id: 'al2', base64: 'AA==', mediaType: 'image/png', size: 250 })
    expect(await getTotalSize('alice@x')).toBe(350)
    await deleteAttachment('al1')
    expect(await getTotalSize('alice@x')).toBe(250)

    setUser('bob@x')
    await putAttachment({ id: 'bo1', base64: 'AA==', mediaType: 'image/png', size: 99 })
    expect(await getTotalSize('bob@x')).toBe(99)

    // Clearing alice leaves bob's records + total intact.
    await clearForUser('alice@x')
    expect(await getTotalSize('alice@x')).toBe(0)
    expect(await getAttachment('al2')).toBeNull()
    expect(await getTotalSize('bob@x')).toBe(99)
    expect(await getAttachment('bo1')).toBe('AA==')
  })
})

describe('attachmentStore — content-block helpers', () => {
  it('buildContentBlocks: no attachments → plain string', async () => {
    expect(await buildContentBlocks('hi', [])).toBe('hi')
    expect(await buildContentBlocks('hi', undefined)).toBe('hi')
  })

  it('buildContentBlocks: image → image block, pdf → document block, files BEFORE text', async () => {
    const getBytes = async (id) => ({ img: 'IMGDATA', pdf: 'PDFDATA' })[id]
    const blocks = await buildContentBlocks(
      'caption',
      [
        { id: 'img', mediaType: 'image/png' },
        { id: 'pdf', mediaType: 'application/pdf' },
      ],
      getBytes,
    )
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMGDATA' } })
    expect(blocks[1]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'PDFDATA' },
    })
    expect(blocks[2]).toEqual({ type: 'text', text: 'caption' })
  })

  it('contentToText returns the string for strings and joined text blocks for arrays', () => {
    expect(contentToText('plain')).toBe('plain')
    expect(
      contentToText([{ type: 'image', source: {} }, { type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }]),
    ).toBe('line1\nline2')
  })

  // base64 of UTF-8 bytes, the way putAttachment stores a decoded text file.
  const b64Utf8 = (s) => Buffer.from(s, 'utf8').toString('base64')

  it('buildContentBlocks: a text attachment → fenced <attachment> text block before the user text', async () => {
    const getBytes = async () => b64Utf8('name,role\nAsha,ops')
    const blocks = await buildContentBlocks(
      'summarise this',
      [{ id: 't', name: 'roster.csv', mediaType: 'text/csv' }],
      getBytes,
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      type: 'text',
      text: '<attachment name="roster.csv" type="text">\nname,role\nAsha,ops\n</attachment>',
    })
    expect(blocks[1]).toEqual({ type: 'text', text: 'summarise this' })
  })

  it('buildContentBlocks: decodes multibyte + BOM-prefixed text correctly (not bare atob)', async () => {
    const getBytes = async () => b64Utf8('﻿café,€,日本') // leading BOM, accents, euro, CJK
    const blocks = await buildContentBlocks('go', [{ id: 't', name: 'm.txt', mediaType: 'text/plain' }], getBytes)
    // BOM stripped, bytes round-trip exactly — bare atob would mojibake these.
    expect(blocks[0].text).toBe('<attachment name="m.txt" type="text">\ncafé,€,日本\n</attachment>')
  })

  it('buildContentBlocks: text block is emitted even when binary:false (sticky); binary is skipped', async () => {
    const getBytes = async (id) => (id === 'txt' ? b64Utf8('hi,there') : 'IMGDATA')
    const blocks = await buildContentBlocks(
      'q',
      [
        { id: 'txt', name: 'a.csv', mediaType: 'text/csv' },
        { id: 'img', name: 'b.png', mediaType: 'image/png' },
      ],
      getBytes,
      { binary: false },
    )
    // Only the sticky text block + the user text; the image is dropped on a non-newest turn.
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toContain('<attachment name="a.csv"')
    expect(blocks[1]).toEqual({ type: 'text', text: 'q' })
  })

  it('buildContentBlocks skips a text attachment with corrupt base64 instead of throwing the whole send', async () => {
    // '@@@' isn't valid base64 → decode throws; the bad ref must be skipped (like
    // the missing-bytes path), not reject assembly and lock the composer.
    const getBytes = async (id) => (id === 'good' ? b64Utf8('ok,1') : '@@@not-base64@@@')
    const blocks = await buildContentBlocks(
      'q',
      [
        { id: 'bad', name: 'bad.csv', mediaType: 'text/csv' },
        { id: 'good', name: 'good.csv', mediaType: 'text/csv' },
      ],
      getBytes,
    )
    expect(blocks).toHaveLength(2) // bad skipped; good text block + user text remain
    expect(blocks[0].text).toContain('good.csv')
    expect(blocks[1]).toEqual({ type: 'text', text: 'q' })
  })

  it('buildContentBlocks skips a ref whose bytes are missing (no null-data block)', async () => {
    const getBytes = async (id) => (id === 'present' ? 'DATA' : null)
    const blocks = await buildContentBlocks(
      'caption',
      [
        { id: 'gone', mediaType: 'image/png' },
        { id: 'present', mediaType: 'image/png' },
      ],
      getBytes,
    )
    // Only the present image block + the text block; the missing one is dropped.
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'image', source: { data: 'DATA' } })
    expect(blocks[1]).toEqual({ type: 'text', text: 'caption' })
  })

  it('assembleApiMessages maps string turns through and attachment turns to blocks', async () => {
    const getBytes = async () => 'IMGDATA'
    const out = await assembleApiMessages(
      [
        { role: 'user', content: 'plain question' },
        { role: 'assistant', content: 'plain answer' },
        { role: 'user', content: 'look at this', attachments: [{ id: 'a', mediaType: 'image/png' }] },
      ],
      getBytes,
    )
    expect(out[0]).toEqual({ role: 'user', content: 'plain question' })
    expect(out[1]).toEqual({ role: 'assistant', content: 'plain answer' })
    expect(Array.isArray(out[2].content)).toBe(true)
    expect(out[2].content[0]).toMatchObject({ type: 'image', source: { data: 'IMGDATA' } }) // file first
    expect(out[2].content[1]).toEqual({ type: 'text', text: 'look at this' }) // text last
  })

  it('keeps a text attachment sticky across turns but does NOT re-send an old image', async () => {
    const getBytes = async (id) => (id === 'csv' ? Buffer.from('a,b\n1,2', 'utf8').toString('base64') : 'IMGDATA')
    const out = await assembleApiMessages(
      [
        { role: 'user', content: 'turn 1', attachments: [
          { id: 'csv', name: 'd.csv', mediaType: 'text/csv' },
          { id: 'img', name: 'p.png', mediaType: 'image/png' },
        ] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'turn 2 question' }, // newest, no attachments
      ],
      getBytes,
    )
    // Turn 1 is no longer newest: the CSV is still inlined (sticky) but the image is gone.
    expect(Array.isArray(out[0].content)).toBe(true)
    const turn1Text = out[0].content.map((b) => b.text || '').join('|')
    expect(turn1Text).toContain('<attachment name="d.csv"')
    expect(out[0].content.some((b) => b.type === 'image')).toBe(false)
    // Plain turns unchanged.
    expect(out[1]).toEqual({ role: 'assistant', content: 'ok' })
    expect(out[2]).toEqual({ role: 'user', content: 'turn 2 question' })
  })
})

describe('countAttachments', () => {
  it('sums attachment refs across all turns', () => {
    const messages = [
      { role: 'user', content: 'hi', attachments: [{ id: '1' }, { id: '2' }] },
      { role: 'assistant', content: 'ok' }, // no attachments key
      { role: 'user', content: 'more', attachments: [{ id: '3' }] },
    ]
    expect(countAttachments(messages)).toBe(3)
  })

  it('is 0 for empty / attachment-free / non-array inputs', () => {
    expect(countAttachments([])).toBe(0)
    expect(countAttachments([{ role: 'user', content: 'x' }])).toBe(0)
    expect(countAttachments(null)).toBe(0)
    expect(countAttachments(undefined)).toBe(0)
  })
})

describe('attachmentStore — resilience', () => {
  it('a throwing/absent IndexedDB is swallowed by reads (get → null, total → 0)', async () => {
    vi.resetModules()
    const orig = globalThis.indexedDB
    globalThis.indexedDB = {
      open: () => {
        throw new Error('no indexeddb here')
      },
    }
    try {
      const mod = await import('../attachmentStore.js')
      expect(await mod.getAttachment('whatever')).toBeNull()
      expect(await mod.getTotalSize('nobody')).toBe(0)
    } finally {
      globalThis.indexedDB = orig
    }
  })
})
