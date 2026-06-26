import { describe, it, expect, vi } from 'vitest'
import { convertDeckToPdf, countPdfPages } from '../deck-convert.js'
import { assertZipNotBomb } from '../file-parse.js' // re-exported from zip-safety (back-compat)
import { makePptx, makeDocx, makeXlsx, makeZip } from './officeFixtures.js'

const URL = 'http://gotenberg.test'

/** A minimal PDF with `pages` page objects so countPdfPages() returns `pages`. */
function fakePdf(pages) {
  const body = Array.from({ length: pages }, (_, i) => `<< /Type /Page /i ${i} >>\n`).join('')
  return Buffer.from(`%PDF-1.5\n${body}trailer\n%%EOF`)
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/** A fetch stub that returns a PDF with `pages` pages and records its calls. */
function okFetch(pages) {
  return vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(fakePdf(pages)) }))
}

describe('countPdfPages', () => {
  it('counts /Type /Page objects (and not /Pages)', () => {
    const pdf = Buffer.from('%PDF\n<< /Type /Pages /Count 3 >> << /Type /Page >> << /Type/Page >>')
    expect(countPdfPages(pdf)).toBe(2)
  })
  it('returns 0 when none present', () => {
    expect(countPdfPages(Buffer.from('%PDF nothing here'))).toBe(0)
  })
})

describe('convertDeckToPdf — happy path', () => {
  it('returns the PDF bytes and a page count matching the rendered PDF', async () => {
    const pptx = await makePptx({ slides: 3 })
    const fetchImpl = okFetch(3)
    const out = await convertDeckToPdf(pptx, { url: URL, fetchImpl })

    expect(out.mediaType).toBe('application/pdf')
    expect(out.pageCount).toBe(3)
    expect(out.pdf.subarray(0, 4).toString()).toBe('%PDF')
    // Called exactly once, hitting the LibreOffice route on the configured sidecar.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${URL}/forms/libreoffice/convert`)
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST')
  })

  it('floors pageCount at 1 when the PDF has no detectable page markers', async () => {
    const pptx = await makePptx({ slides: 1 })
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => toArrayBuffer(Buffer.from('%PDF-1.5\n(no page dicts)\n%%EOF')),
    }))
    const out = await convertDeckToPdf(pptx, { url: URL, fetchImpl })
    expect(out.pageCount).toBe(1)
  })
})

describe('convertDeckToPdf — structural gate (before any HTTP call)', () => {
  it('rejects a .docx mislabelled as .pptx (no ppt/presentation.xml)', async () => {
    const fetchImpl = okFetch(1)
    await expect(convertDeckToPdf(await makeDocx(), { url: URL, fetchImpl })).rejects.toMatchObject({
      name: 'DeckConvertError',
      status: 415,
      code: 'UNSUPPORTED_DECK',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an .xlsx mislabelled as .pptx', async () => {
    const fetchImpl = okFetch(1)
    await expect(
      convertDeckToPdf(makeXlsx([{ name: 'S', aoa: [['a']] }]), { url: URL, fetchImpl }),
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_DECK' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an arbitrary zip with no ppt/presentation.xml', async () => {
    const fetchImpl = okFetch(1)
    await expect(
      convertDeckToPdf(await makeZip({ 'hello.txt': 'hi' }), { url: URL, fetchImpl }),
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_DECK' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects non-zip bytes with a ZIP-signature error', async () => {
    const fetchImpl = okFetch(1)
    await expect(
      convertDeckToPdf(Buffer.from('this is plainly not a zip at all'), { url: URL, fetchImpl }),
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_DECK' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('convertDeckToPdf — resource guards', () => {
  it('rejects a zip-bomb (declared decompressed size over cap) before rendering', async () => {
    const pptx = await makePptx({ slides: 2 })
    const fetchImpl = okFetch(1)
    // Tiny cap forces the real central-directory size sum over the limit.
    await expect(
      convertDeckToPdf(pptx, { url: URL, fetchImpl, maxDecompressedBytes: 32 }),
    ).rejects.toMatchObject({ name: 'DeckConvertError', status: 413, code: 'FILE_TOO_LARGE' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a converted PDF whose page count exceeds the cap', async () => {
    const pptx = await makePptx({ slides: 5 })
    const fetchImpl = okFetch(5)
    await expect(
      convertDeckToPdf(pptx, { url: URL, fetchImpl, maxPages: 2 }),
    ).rejects.toMatchObject({ status: 413, code: 'TOO_MANY_PAGES' })
  })
})

describe('convertDeckToPdf — renderer failures', () => {
  it('maps a 5xx from the renderer to 502', async () => {
    const pptx = await makePptx({ slides: 1 })
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }))
    await expect(convertDeckToPdf(pptx, { url: URL, fetchImpl })).rejects.toMatchObject({
      status: 502,
      code: 'RENDERER_UNAVAILABLE',
    })
  })

  it('maps a connection failure (fetch throws) to 502', async () => {
    const pptx = await makePptx({ slides: 1 })
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(convertDeckToPdf(pptx, { url: URL, fetchImpl })).rejects.toMatchObject({
      status: 502,
      code: 'RENDERER_UNAVAILABLE',
    })
  })

  it('maps a wall-clock timeout (abort) to 504', async () => {
    const pptx = await makePptx({ slides: 1 })
    // fetch that only rejects when the abort signal fires.
    const fetchImpl = vi.fn(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }),
    )
    await expect(convertDeckToPdf(pptx, { url: URL, fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
      status: 504,
      code: 'RENDERER_TIMEOUT',
    })
  })

  it('rejects an invalid (non-%PDF) renderer output as 502', async () => {
    const pptx = await makePptx({ slides: 1 })
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => toArrayBuffer(Buffer.from('NOT A PDF')),
    }))
    await expect(convertDeckToPdf(pptx, { url: URL, fetchImpl })).rejects.toMatchObject({
      status: 502,
      code: 'RENDERER_BAD_OUTPUT',
    })
  })

  it('rejects with 503 when no sidecar URL is configured', async () => {
    const pptx = await makePptx({ slides: 1 })
    const fetchImpl = okFetch(1)
    await expect(convertDeckToPdf(pptx, { url: '', fetchImpl })).rejects.toMatchObject({
      status: 503,
      code: 'RENDERER_UNCONFIGURED',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('invisible conversion — no user-facing message mentions PDF', () => {
  const pptxP = makePptx({ slides: 1 })

  async function messageFrom(opts) {
    try {
      await convertDeckToPdf(await pptxP, { url: URL, ...opts })
      return ''
    } catch (e) {
      return e.message
    }
  }

  it('the bad-output / timeout / unavailable / over-cap messages never say "PDF" or "convert"', async () => {
    const badOutput = await messageFrom({
      fetchImpl: vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(Buffer.from('NOPE')) })),
    })
    const unavailable = await messageFrom({ fetchImpl: vi.fn(async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) })) })
    const overCap = await messageFrom({ maxPages: 1, fetchImpl: okFetch(5) })

    for (const msg of [badOutput, unavailable, overCap]) {
      expect(msg).not.toMatch(/pdf/i)
      expect(msg).not.toMatch(/convert/i)
    }
    expect(badOutput).toMatch(/\.pptx/) // it guides the user back to .pptx, not PDF
  })
})

describe('zip-safety back-compat', () => {
  it('assertZipNotBomb is still re-exported from file-parse.js', () => {
    expect(typeof assertZipNotBomb).toBe('function')
    expect(() => assertZipNotBomb(Buffer.from('not a zip at all, but long enough to scan'))).toThrow(
      /Malformed archive/,
    )
  })
})
