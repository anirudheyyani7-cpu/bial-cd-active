/**
 * Deck conversion: `.pptx` bytes -> validated PDF buffer + page count, via a
 * self-hosted Gotenberg (LibreOffice) sidecar. This is a NEW pipeline, separate
 * from office-extract.js: a deck is a VISUAL medium, so it is rendered to PDF
 * (which Claude reads with vision) rather than text-extracted.
 *
 * The input is UNTRUSTED, and LibreOffice is a large native attack surface, so we
 * validate BEFORE the renderer ever touches the bytes:
 *   1. structural gate — ZIP signature + the `ppt/presentation.xml` OPC part
 *      (parser-free; rejects a .docx/.xlsx/.zip mislabelled as .pptx).
 *   2. zip-bomb guard — sum the central-directory uncompressed sizes and reject
 *      an over-cap archive before LibreOffice inflates it.
 *   3. hard wall-clock timeout on the conversion (abort + typed 504, never a hang).
 *   4. page-count cap on the produced PDF (cost + model-limit governor).
 *
 * Pure-ish and dependency-injectable (`fetchImpl`) so it unit-tests without a
 * running sidecar.
 */
import { assertOfficeStructure, OfficeExtractError } from './office-extract.js'
import { assertZipNotBomb, FileParseError } from './zip-safety.js'
import { posIntOr } from './util-validate.js'
import { gotenbergUrl, maxDeckPages } from './deck-config.js'

/** Default conversion wall-clock budget. Align the Gotenberg sidecar's own
 *  `--api-timeout` at or below this so neither side hangs. Env-tunable. */
const DEFAULT_TIMEOUT_MS = posIntOr(process.env.DECK_CONVERT_TIMEOUT_MS, 60_000)

const PDF_MAGIC = Buffer.from('%PDF')

/**
 * Typed error so the route maps failures HTTP-faithfully:
 *   415 UNSUPPORTED_DECK   — not a valid .pptx (bad/missing OPC structure)
 *   413 TOO_MANY_PAGES / DECK_TOO_LARGE — over the page cap / a zip-bomb
 *   502 RENDERER_UNAVAILABLE / RENDERER_BAD_OUTPUT — sidecar down or bad output
 *   503 RENDERER_UNCONFIGURED — no GOTENBERG_URL
 *   504 RENDERER_TIMEOUT   — conversion exceeded the wall-clock budget
 */
export class DeckConvertError extends Error {
  constructor(message, { status = 400, code = 'DECK_CONVERT_ERROR' } = {}) {
    super(message)
    this.name = 'DeckConvertError'
    this.status = status
    this.code = code
  }
}

/**
 * Count pages in a PDF by scanning for `/Type /Page` objects (not `/Pages`, the
 * page-tree root). Dependency-free and reliable for LibreOffice/Gotenberg output
 * (uncompressed page dictionaries). NOTE: a PDF that packs its page tree into
 * compressed object streams would undercount — acceptable here because the
 * authoritative cost ceiling is the server-side daily token gate, and Gotenberg's
 * LibreOffice export does not compress page dicts.
 */
export function countPdfPages(buffer) {
  if (!Buffer.isBuffer(buffer)) return 0
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page\b/g)
  return matches ? matches.length : 0
}

/** Gotenberg routes by file extension, so the multipart filename MUST end in
 *  `.pptx`. Sanitise the user-supplied name and force the extension. */
function safePptxName(name) {
  const base = String(name || '')
    .replace(/\.pptx$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
  return `${base || 'deck'}.pptx`
}

/**
 * Convert `.pptx` bytes to a validated PDF.
 * @returns {Promise<{ pdf: Buffer, pageCount: number, mediaType: 'application/pdf' }>}
 * @throws {DeckConvertError}
 */
export async function convertDeckToPdf(
  buffer,
  {
    name = 'deck.pptx',
    url = gotenbergUrl(),
    maxPages = maxDeckPages(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxDecompressedBytes,
    fetchImpl = fetch,
  } = {},
) {
  // 1. Structural gate (cheap, parser-free) — reject non-.pptx before anything else.
  try {
    assertOfficeStructure(buffer, 'powerpoint')
  } catch (err) {
    if (err instanceof OfficeExtractError) {
      throw new DeckConvertError(err.message, { status: 415, code: 'UNSUPPORTED_DECK' })
    }
    throw err
  }

  // 2. Zip-bomb guard — the .pptx is a ZIP; reject before LibreOffice inflates it.
  try {
    assertZipNotBomb(buffer, maxDecompressedBytes)
  } catch (err) {
    if (err instanceof FileParseError) {
      throw new DeckConvertError(err.message, { status: err.status || 413, code: err.code || 'DECK_TOO_LARGE' })
    }
    throw err
  }

  if (!url) {
    throw new DeckConvertError('Deck conversion is not configured.', {
      status: 503,
      code: 'RENDERER_UNCONFIGURED',
    })
  }

  // 3. Render to PDF via Gotenberg's LibreOffice route, bounded by a hard timeout.
  const form = new FormData()
  form.append('files', new Blob([buffer]), safePptxName(name))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(`${url}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new DeckConvertError('Deck conversion timed out. Try a smaller deck.', {
        status: 504,
        code: 'RENDERER_TIMEOUT',
      })
    }
    throw new DeckConvertError('Deck conversion service is unavailable.', {
      status: 502,
      code: 'RENDERER_UNAVAILABLE',
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new DeckConvertError(`Deck conversion failed (renderer responded ${res.status}).`, {
      status: 502,
      code: 'RENDERER_UNAVAILABLE',
    })
  }

  const pdf = Buffer.from(await res.arrayBuffer())

  // 4. Sanity + page-count cap.
  if (pdf.length < 4 || !pdf.subarray(0, 4).equals(PDF_MAGIC)) {
    throw new DeckConvertError('Deck conversion produced an invalid PDF.', {
      status: 502,
      code: 'RENDERER_BAD_OUTPUT',
    })
  }
  const pages = countPdfPages(pdf)
  if (pages > maxPages) {
    throw new DeckConvertError(
      `This deck is ${pages} pages, over the ${maxPages}-page limit. Please split it or upload a smaller deck.`,
      { status: 413, code: 'TOO_MANY_PAGES' },
    )
  }

  // A deck always has >= 1 slide; floor at 1 when the byte-scan can't detect pages.
  return { pdf, pageCount: Math.max(1, pages), mediaType: 'application/pdf' }
}
