import { describe, it, expect } from 'vitest'
import {
  validateAttachmentFiles,
  validateConversationAttachmentCap,
  resolveMediaType,
  textAttachmentBytes,
  fileToBase64,
  ACCEPT_ATTR,
  MAX_FILE_SIZE,
  MAX_TEXT_FILE_SIZE,
  MAX_TEXT_BYTES_PER_CONVERSATION,
  MAX_FILES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_CONVERSATION,
  validatePdfPerMessageCap,
  countPdfAttachments,
  MAX_PDF_ATTACHMENTS_PER_MESSAGE,
  TOO_MANY_DOCUMENTS_MESSAGE,
} from '../attachmentInput'

// validateAttachmentFiles only reads name/type/size, so plain objects suffice
// (and let us set an arbitrary size without allocating megabytes).
const file = (name, type, size = 1024) => ({ name, type, size })

describe('validateAttachmentFiles', () => {




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
    expect(validateAttachmentFiles([file('spec.pdf', 'application/pdf', MAX_FILE_SIZE)], 0)).toEqual({ ok: true })
  })

  it('rejects a selection whose total text bytes exceed the per-conversation budget', () => {
    // 5 × 256 KB text files pass the per-file cap but bust the 512 KB total.
    const five = Array.from({ length: 5 }, (_, i) => file(`f${i}.txt`, 'text/plain', MAX_TEXT_FILE_SIZE))
    const res = validateAttachmentFiles(five, 0)
    expect(res.error).toMatch(new RegExp(`${MAX_TEXT_BYTES_PER_CONVERSATION / 1024} KB total`))
  })

  it('enforces the text budget CUMULATIVELY across pending picks (existingTextBytes)', () => {
    // 400 KB already pending + a new 200 KB pick = 600 KB > 512 KB → rejected,
    // even though the new pick alone is well under the budget.
    const res = validateAttachmentFiles([file('more.csv', 'text/csv', 200 * 1024)], 2, 400 * 1024)
    expect(res.error).toMatch(new RegExp(`${MAX_TEXT_BYTES_PER_CONVERSATION / 1024} KB total`))
    // A pick that keeps the running total under budget still passes.
    expect(validateAttachmentFiles([file('ok.csv', 'text/csv', 100 * 1024)], 1, 200 * 1024)).toEqual({ ok: true })
  })
})

describe('textAttachmentBytes', () => {
  it('sums the size of text refs only (ignores image/PDF)', () => {
    expect(
      textAttachmentBytes([
        { mediaType: 'text/csv', size: 1000 },
        { mediaType: 'image/png', size: 5000 },
        { mediaType: 'application/pdf', size: 9000 },
        { mediaType: 'text/plain', size: 200 },
      ]),
    ).toBe(1200)
  })

  it('is 0 for empty / non-array inputs', () => {
    expect(textAttachmentBytes([])).toBe(0)
    expect(textAttachmentBytes(null)).toBe(0)
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

// `officeFormat` and the two deck suites are GONE, along with the media types they described.
// Their inertness is asserted in `attachmentInput-deck-disabled.test.js`, which stopped
// mocking the flag when the flag stopped existing — a removal's tests become guards, not gaps.

describe('ACCEPT_ATTR', () => {
  it('offers the text types and their extension tokens, and nothing needing conversion', () => {
    expect(ACCEPT_ATTR).toContain('text/csv')
    expect(ACCEPT_ATTR).toContain('text/plain')
    expect(ACCEPT_ATTR).toContain('.csv')
    expect(ACCEPT_ATTR).toContain('.txt')
    expect(ACCEPT_ATTR).toContain('application/pdf')
    expect(ACCEPT_ATTR).toContain('image/png')
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
    expect(validateConversationAttachmentCap(MAX_ATTACHMENTS_PER_CONVERSATION - 1, 3).error).toBeTruthy()
  })

  it('uses wording distinct from the per-message and storage-full caps', () => {
    const res = validateConversationAttachmentCap(MAX_ATTACHMENTS_PER_CONVERSATION, 1)
    expect(res.error).toMatch(/this conversation/i)
    expect(res.error).not.toMatch(/per message/i)
  })
})

describe('validatePdfPerMessageCap (#194 — the DOCUMENT limit)', () => {
  const pdf = (id) => ({ id, name: `${id}.pdf`, mediaType: 'application/pdf', size: 1024, base64: '' })
  const png = (id) => ({ id, name: `${id}.png`, mediaType: 'image/png', size: 1024, base64: '' })
  const csv = (id) => ({ id, name: `${id}.csv`, mediaType: 'text/csv', size: 128, base64: '' })

  it('accepts up to the cap and rejects the one past it', () => {
    expect(validatePdfPerMessageCap([])).toEqual({ ok: true })
    expect(validatePdfPerMessageCap([pdf('a')])).toEqual({ ok: true })
    expect(validatePdfPerMessageCap([pdf('a'), pdf('b')])).toEqual({ ok: true })
    expect(validatePdfPerMessageCap([pdf('a'), pdf('b'), pdf('c')]).error).toBe(TOO_MANY_DOCUMENTS_MESSAGE)
  })

  it('counts DOCUMENTS, not attachments — images and text never trip it', () => {
    // The whole point of the flat PDF charge is that it does not apply to the other kinds. Eight
    // images cost 1,600 each and must still send; a cap that counted attachments would refuse them.
    expect(validatePdfPerMessageCap([png('a'), png('b'), png('c'), png('d'), csv('e')])).toEqual({ ok: true })
    expect(validatePdfPerMessageCap([pdf('a'), pdf('b'), png('c'), csv('d')])).toEqual({ ok: true })
    expect(countPdfAttachments([pdf('a'), png('b'), pdf('c')])).toBe(2)
  })

  it('names the DOCUMENT limit and never tells the citizen to start a new chat', () => {
    // A new chat refuses the identical message, so that advice is a dead end. This is the whole
    // reason the refusal is separate from the token gate's.
    const res = validatePdfPerMessageCap([pdf('a'), pdf('b'), pdf('c')])
    expect(res.error).toMatch(/documents in one message/i)
    expect(res.error).not.toMatch(/new chat/i)
    expect(res.error).not.toMatch(/token|context|limit of \d+ attachments/i)
  })

  it('agrees with the server, which is the trust boundary', () => {
    // Mirrors backend/src/api/v1/conversations/_shared.py: MAX_PDF_BLOCKS + TOO_MANY_DOCUMENTS_MSG.
    expect(MAX_PDF_ATTACHMENTS_PER_MESSAGE).toBe(2)
    expect(TOO_MANY_DOCUMENTS_MESSAGE).toBe(
      'You can send up to 2 documents in one message. Take one out and send again.',
    )
  })

  it('tolerates a list whose entries carry no mediaType', () => {
    expect(countPdfAttachments([{}, { mediaType: undefined }])).toBe(0)
    expect(validatePdfPerMessageCap([{}])).toEqual({ ok: true })
  })
})

describe('fileToBase64', () => {
  it('reads a Blob as raw base64 (data: prefix stripped)', async () => {
    const blob = new File(['ABC'], 'a.png', { type: 'image/png' })
    expect(await fileToBase64(blob)).toBe('QUJD') // base64('ABC')
  })
})

// THE SHIPPED DEFAULT block is gone with the flag it pinned.
//
// It existed because a past change turned the deck feature off and nothing went red: both deck spec
// files mocked `config/features`, so between them they covered two hypothetical worlds and
// neither said which one we shipped. There is no flag to pin now — presentations, spreadsheets and
// documents are refused outright — and the inertness guard that replaces this lives in
// `attachmentInput-deck-disabled.test.js`, which stopped mocking when the flag stopped existing.
