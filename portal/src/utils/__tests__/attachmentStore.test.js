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
