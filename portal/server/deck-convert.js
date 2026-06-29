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
 *   2. zip-bomb PRE-FILTER — sum the central-directory *declared* uncompressed
 *      sizes and reject an obviously over-cap archive before LibreOffice inflates
 *      it. Declared sizes are attacker-controlled, so this is a cheap first cut,
 *      NOT the real guarantee — the renderer container's memory/time limits are
 *      the actual zip-bomb boundary (ops/gotenberg/README.md).
 *   3. hard wall-clock timeout on the conversion (abort + typed 504, never a hang).
 *   4. page-count cap on the produced PDF (cost + model-limit governor).
 *
 * Pure-ish and dependency-injectable (`fetchImpl`) so it unit-tests without a
 * running sidecar.
 */
import { assertOfficeStructure, OfficeExtractError, POWERPOINT_FORMAT } from './office-extract.js'
import { assertZipNotBomb, FileParseError } from './zip-safety.js'
import { posIntOr } from './util-validate.js'
import { gotenbergUrl, maxDeckPages } from './deck-config.js'

/** Default conversion wall-clock budget. Align the Gotenberg sidecar's own
 *  `--api-timeout` at or below this so neither side hangs. Env-tunable. */
const DEFAULT_TIMEOUT_MS = posIntOr(process.env.DECK_CONVERT_TIMEOUT_MS, 60_000)

/** Hard cap on the rendered PDF we'll buffer in memory. A deck under the page cap
 *  renders to a few MB; a pathological/hostile render that balloons past this is
 *  rejected (Content-Length pre-check + materialized-length re-check) instead of
 *  being read unbounded. Env-tunable. */
const MAX_PDF_BYTES = posIntOr(process.env.DECK_MAX_PDF_BYTES, 50 * 1024 * 1024)

const PDF_MAGIC = Buffer.from('%PDF')

/** `/Type /Page` page-object markers, in the two spellings LibreOffice/Gotenberg
 *  emits (one space, or none). Scanned as raw bytes — see countPdfPages. */
const PAGE_NEEDLE_SP = Buffer.from('/Type /Page', 'latin1')
const PAGE_NEEDLE = Buffer.from('/Type/Page', 'latin1')

/** True for a byte that `\b` would treat as a word char (`[A-Za-z0-9_]`). Used to
 *  reject `/Type /Pages` (the page-tree root) the same way the prior regex `\b` did. */
function isWordByte(b) {
  if (b === undefined) return false // past the buffer end = a boundary
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f
}

/**
 * Typed error so the route maps failures HTTP-faithfully:
 *   415 UNSUPPORTED_DECK   — not a valid .pptx (bad/missing OPC structure)
 *   413 TOO_MANY_PAGES / DECK_TOO_LARGE / RENDERER_OUTPUT_TOO_LARGE — over the page
 *        cap / a zip-bomb / an over-size rendered body
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
  // Scan the raw bytes for both markers instead of materialising the whole buffer
  // as a string. A trailing word char (e.g. the "s" in `/Type /Pages`) disqualifies
  // a hit — the same exclusion the prior regex's `\b` provided.
  let count = 0
  for (const needle of [PAGE_NEEDLE_SP, PAGE_NEEDLE]) {
    let from = 0
    for (;;) {
      const i = buffer.indexOf(needle, from)
      if (i === -1) break
      if (!isWordByte(buffer[i + needle.length])) count += 1
      from = i + needle.length
    }
  }
  return count
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
    maxPdfBytes = MAX_PDF_BYTES,
    fetchImpl = fetch,
  } = {},
) {
  // 1. Structural gate (cheap, parser-free) — reject non-.pptx before anything else.
  try {
    assertOfficeStructure(buffer, POWERPOINT_FORMAT)
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
    throw new DeckConvertError("PowerPoint attachments aren't available right now.", {
      status: 503,
      code: 'RENDERER_UNCONFIGURED',
    })
  }

  // 3. Render to PDF via Gotenberg's LibreOffice route, bounded by a hard timeout.
  const form = new FormData()
  form.append('files', new Blob([buffer]), safePptxName(name))

  // Keep the abort signal armed across BOTH the request AND the body read, so a
  // sidecar that accepts the POST but then dribbles (or never finishes) the body
  // still trips the wall-clock budget. clearTimeout runs once, after the read.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let pdf
  try {
    const res = await fetchImpl(`${url}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new DeckConvertError("Couldn't process the deck. Please try again.", {
        status: 502,
        code: 'RENDERER_UNAVAILABLE',
      })
    }
    // Reject an over-size body up front via the declared Content-Length (cheap),
    // then re-check the materialized length — the header is advisory and may be
    // absent — so we never buffer an unbounded PDF into memory.
    const declared = Number(res.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > maxPdfBytes) {
      throw new DeckConvertError('This deck is too large to process. Try a smaller deck.', {
        status: 413,
        code: 'RENDERER_OUTPUT_TOO_LARGE',
      })
    }
    pdf = Buffer.from(await res.arrayBuffer())
    if (pdf.length > maxPdfBytes) {
      throw new DeckConvertError('This deck is too large to process. Try a smaller deck.', {
        status: 413,
        code: 'RENDERER_OUTPUT_TOO_LARGE',
      })
    }
  } catch (err) {
    if (err instanceof DeckConvertError) throw err // our typed mappings pass through as-is
    if (err && err.name === 'AbortError') {
      throw new DeckConvertError('This deck took too long to process. Try a smaller deck.', {
        status: 504,
        code: 'RENDERER_TIMEOUT',
      })
    }
    throw new DeckConvertError("Couldn't process the deck right now. Please try again.", {
      status: 502,
      code: 'RENDERER_UNAVAILABLE',
    })
  } finally {
    clearTimeout(timer)
  }

  // 4. Sanity + page-count cap.
  if (pdf.length < 4 || !pdf.subarray(0, 4).equals(PDF_MAGIC)) {
    throw new DeckConvertError("We couldn't process this deck. Please try re-saving it as a .pptx.", {
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
