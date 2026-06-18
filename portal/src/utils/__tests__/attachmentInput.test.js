import { describe, it, expect } from 'vitest'
import {
  validateAttachmentFiles,
  validateConversationAttachmentCap,
  resolveMediaType,
  fileToBase64,
  toAttachmentRef,
  ACCEPT_ATTR,
  WORD_REJECT_MSG,
  MAX_FILE_SIZE,
  MAX_TEXT_FILE_SIZE,
  MAX_TEXT_BYTES_PER_CONVERSATION,
  MAX_FILES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_CONVERSATION,
} from '../attachmentInput.js'

// validateAttachmentFiles only reads name/type/size, so plain objects suffice
// (and let us set an arbitrary size without allocating megabytes).
const file = (name, type, size = 1024) => ({ name, type, size })

describe('validateAttachmentFiles', () => {
  it('rejects a .docx with the "save as PDF" message (even with an empty MIME type)', () => {
    expect(validateAttachmentFiles([file('plan.docx', '')], 0)).toEqual({ error: WORD_REJECT_MSG })
    expect(validateAttachmentFiles([file('legacy.doc', 'application/msword')], 0)).toEqual({ error: WORD_REJECT_MSG })
  })

  it('rejects a genuinely unsupported type with a generic message', () => {
    const res = validateAttachmentFiles([file('clip.mp3', 'audio/mpeg')], 0)
    expect(res.error).toMatch(/isn't supported/)
  })

  it('rejects a file over the 4 MB limit', () => {
    const res = validateAttachmentFiles([file('huge.png', 'image/png', MAX_FILE_SIZE + 1)], 0)
    expect(res.error).toMatch(/4 MB/)
  })

  it('rejects exceeding the per-message file cap', () => {
    const res = validateAttachmentFiles([file('a.png', 'image/png')], MAX_FILES_PER_MESSAGE)
    expect(res.error).toMatch(new RegExp(`at most ${MAX_FILES_PER_MESSAGE} files`))
  })

  it('accepts valid images and a PDF under the caps', () => {
    expect(validateAttachmentFiles([file('a.png', 'image/png')], 0)).toEqual({ ok: true })
    expect(validateAttachmentFiles([file('b.jpg', 'image/jpeg')], 0)).toEqual({ ok: true })
    expect(validateAttachmentFiles([file('c.pdf', 'application/pdf')], 0)).toEqual({ ok: true })
  })

  it('accepts a .txt (text/plain) and a .csv under the text caps', () => {
    expect(validateAttachmentFiles([file('notes.txt', 'text/plain')], 0)).toEqual({ ok: true })
    expect(validateAttachmentFiles([file('rows.csv', 'text/csv')], 0)).toEqual({ ok: true })
  })

  it('accepts an OS-mislabeled .csv (reported application/vnd.ms-excel or empty) via resolved type', () => {
    // Validation must run against the resolved type, not raw file.type — so a CSV
    // the OS labels as Excel (or leaves blank) is still accepted.
    expect(validateAttachmentFiles([file('data.csv', 'application/vnd.ms-excel')], 0)).toEqual({ ok: true })
    expect(validateAttachmentFiles([file('data.csv', '')], 0)).toEqual({ ok: true })
  })

  it('rejects a text file over the 256 KB per-file limit (binary 4 MB cap unchanged)', () => {
    const res = validateAttachmentFiles([file('big.csv', 'text/csv', MAX_TEXT_FILE_SIZE + 1)], 0)
    expect(res.error).toMatch(/256 KB/)
    // A 4 MB PDF is still accepted under the binary cap.
    expect(validateAttachmentFiles([file('spec.pdf', 'application/pdf', MAX_FILE_SIZE)], 0)).toEqual({ ok: true })
  })

  it('rejects a selection whose total text bytes exceed the per-conversation budget', () => {
    // 5 × 256 KB text files pass the per-file cap but bust the 512 KB total.
    const five = Array.from({ length: 5 }, (_, i) => file(`f${i}.txt`, 'text/plain', MAX_TEXT_FILE_SIZE))
    const res = validateAttachmentFiles(five, 0)
    expect(res.error).toMatch(new RegExp(`${MAX_TEXT_BYTES_PER_CONVERSATION / 1024} KB total`))
  })
})

describe('resolveMediaType', () => {
  it('canonicalizes .csv → text/csv and .txt → text/plain by extension', () => {
    expect(resolveMediaType(file('data.csv', 'application/vnd.ms-excel'))).toBe('text/csv')
    expect(resolveMediaType(file('data.CSV', ''))).toBe('text/csv')
    expect(resolveMediaType(file('notes.txt', ''))).toBe('text/plain')
  })

  it('falls through to file.type for non-text extensions', () => {
    expect(resolveMediaType(file('a.png', 'image/png'))).toBe('image/png')
    expect(resolveMediaType(file('c.pdf', 'application/pdf'))).toBe('application/pdf')
  })
})

describe('ACCEPT_ATTR', () => {
  it('carries the text MIME types AND .csv/.txt extension tokens for the OS picker', () => {
    expect(ACCEPT_ATTR).toContain('text/csv')
    expect(ACCEPT_ATTR).toContain('text/plain')
    expect(ACCEPT_ATTR).toContain('.csv')
    expect(ACCEPT_ATTR).toContain('.txt')
  })
})

describe('validateConversationAttachmentCap', () => {
  it('accepts when the cumulative total stays within the cap', () => {
    expect(validateConversationAttachmentCap(0, 5)).toEqual({ ok: true })
    expect(validateConversationAttachmentCap(MAX_ATTACHMENTS_PER_CONVERSATION - 1, 1)).toEqual({ ok: true })
  })

  it('rejects when an incoming batch would cross the cap', () => {
    const res = validateConversationAttachmentCap(MAX_ATTACHMENTS_PER_CONVERSATION, 1)
    expect(res.error).toMatch(new RegExp(`limit of ${MAX_ATTACHMENTS_PER_CONVERSATION} attachments`))
    // a batch that crosses the boundary is rejected wholesale
    expect(validateConversationAttachmentCap(MAX_ATTACHMENTS_PER_CONVERSATION - 1, 3).error).toBeTruthy()
  })

  it('uses wording distinct from the per-message and storage-full caps', () => {
    const res = validateConversationAttachmentCap(MAX_ATTACHMENTS_PER_CONVERSATION, 1)
    expect(res.error).toMatch(/this conversation/i)
    expect(res.error).not.toMatch(/per message/i)
  })
})

describe('toAttachmentRef', () => {
  it('strips the transient base64 down to the persisted ref', () => {
    expect(
      toAttachmentRef({ id: 'x', name: 'a.png', mediaType: 'image/png', size: 12, base64: 'SECRETBYTES' }),
    ).toEqual({ id: 'x', name: 'a.png', mediaType: 'image/png', size: 12 })
  })
})

describe('fileToBase64', () => {
  it('reads a Blob as raw base64 (data: prefix stripped)', async () => {
    const blob = new File(['ABC'], 'a.png', { type: 'image/png' })
    expect(await fileToBase64(blob)).toBe('QUJD') // base64('ABC')
  })
})
