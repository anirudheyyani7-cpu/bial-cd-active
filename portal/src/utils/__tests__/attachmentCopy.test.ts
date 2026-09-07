/**
 * The composer's refusal sentence, reconciled against the allowlist it describes — it goes
 * false the moment `ALLOWED_MEDIA_TYPES` narrows, drift that has shipped here before (".pptx"
 * survived in the copy after the composer stopped taking it), so every accepted format must be
 * NAMED and every refused one must NOT be — both directions, not one.
 *
 * Drives the validator rather than scanning the constant, since the message is assembled from
 * a flag-dependent fragment a source-string read would not see. NOT COVERED HERE, on purpose:
 * `LEGACY_DOC_REJECT_MSG`'s "save as .docx (or PDF)" — reachable and true today, and deleted by
 * the same change that would falsify it.
 */
import { describe, it, expect } from 'vitest'
import { validateAttachmentFiles, ALLOWED_MEDIA_TYPES } from '../attachmentInput'

/**
 * The formats this sentence is ABOUT, as literal media types — not imports, deliberately:
 * they were imported constants until a narrowing deleted three of them, which is the gate
 * working (it could not compile against an allowlist that no longer named them). Literals
 * survive the next narrowing too: a format that stops being exported must still be checked
 * for ABSENCE from the copy.
 */
const WORD_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const EXCEL_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** The user-facing message for a file the composer refuses — fails loudly if it accepted it. */
function refusalFor(file: File): string {
  const result = validateAttachmentFiles([file])
  expect('error' in result, `the composer ACCEPTED "${file.name}" — there is no refusal to read`).toBe(true)
  return (result as { error: string }).error
}

/** A file no allowlist here has ever accepted, so it always reaches the generic refusal. */
const unsupported = () => new File(['x'], 'terminal-3.zip', { type: 'application/zip' })

describe('the composer refusal sentence agrees with the real allowlist', () => {
  it('names every format the picker accepts and none that it refuses', () => {
    const message = refusalFor(unsupported())
    // The bounded inventory of formats this sentence is ABOUT. Each is reconciled in both
    // directions, so narrowing the allowlist without editing the sentence goes red — and so
    // does widening it.
    for (const [type, phrase] of [
      ['image/png', /PNG/i],
      ['image/jpeg', /JPEG/i],
      ['image/gif', /GIF/i],
      ['image/webp', /WebP/i],
      ['application/pdf', /PDF/i],
      ['text/csv', /CSV/i],
      ['text/plain', /TXT/i],
      [WORD_MEDIA_TYPE, /Word|\.docx/i],
      [EXCEL_MEDIA_TYPE, /Excel|\.xlsx/i],
      [PPTX_MEDIA_TYPE, /PowerPoint|\.pptx/i],
    ] as const) {
      if ((ALLOWED_MEDIA_TYPES as readonly string[]).includes(type)) {
        expect(message, `the picker accepts ${type} but the refusal never names it`).toMatch(phrase)
      } else {
        expect(message, `the picker refuses ${type} but the refusal still offers it`).not.toMatch(phrase)
      }
    }
  })

  it('is a real sentence, not an empty string every negative assertion would pass against', () => {
    // The liveness half. `not.toMatch` passes on '' just as happily as on honest copy.
    const message = refusalFor(unsupported())
    expect(message.length).toBeGreaterThan(40)
    expect(message).toContain('terminal-3.zip')
  })

  it('never advises a citizen to bring back a format the picker would also refuse', () => {
    // The refusal sentence as behaviour rather than as a constant: advice is only honest while it
    // leads somewhere.
    // The two legacy messages used to say "save as .docx" and "save as .pptx"; both stopped being
    // followable when those formats were refused too, so both are gone and there is one refusal
    // that names what IS accepted. Driving the validator is what proves that, rather than trusting
    // a constant by reading it.
    for (const legacy of [
      new File(['x'], 'gate-plan.ppt', { type: 'application/vnd.ms-powerpoint' }),
      new File(['x'], 'terminal-brief.doc', { type: 'application/msword' }),
      new File(['x'], 'rota.xlsx', { type: EXCEL_MEDIA_TYPE }),
    ]) {
      // The ADVICE is what is under test, not the whole sentence: the message quotes the
      // citizen's own filename back to them, so `"rota.xlsx" isn't supported` legitimately
      // contains `.xlsx`. Reading the advice half is what separates "we echoed your file's name"
      // from "we told you to bring it back in a format we also refuse".
      const advice = refusalFor(legacy).replace(/^"[^"]*"/, '')
      expect(advice, 'the refusal sends the citizen to a format the picker also refuses').not.toMatch(
        /\.pptx|\.docx|\.xlsx|save as/i,
      )
      // …and it still tells them what WOULD work, rather than only saying no.
      expect(advice).toMatch(/PDF/i)
    }
  })
})
