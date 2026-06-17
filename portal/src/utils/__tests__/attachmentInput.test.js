import { describe, it, expect } from 'vitest'
import {
  validateAttachmentFiles,
  fileToBase64,
  toAttachmentRef,
  WORD_REJECT_MSG,
  MAX_FILE_SIZE,
  MAX_FILES_PER_MESSAGE,
} from '../attachmentInput.js'

// validateAttachmentFiles only reads name/type/size, so plain objects suffice
// (and let us set an arbitrary size without allocating megabytes).
const file = (name, type, size = 1024) => ({ name, type, size })

describe('validateAttachmentFiles', () => {
  it('rejects a .docx with the "save as PDF" message (even with an empty MIME type)', () => {
    expect(validateAttachmentFiles([file('plan.docx', '')], 0)).toEqual({ error: WORD_REJECT_MSG })
    expect(validateAttachmentFiles([file('legacy.doc', 'application/msword')], 0)).toEqual({ error: WORD_REJECT_MSG })
  })

  it('rejects a non-allowed type with a generic message', () => {
    const res = validateAttachmentFiles([file('data.csv', 'text/csv')], 0)
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
