/**
 * Office (.docx / .xlsx) → model-ready Markdown extraction. PURE module: no
 * Express, no DB, no object-store — it takes bytes and returns text, so it is
 * trivially testable and reusable from the upload route.
 *
 * Why server-side extraction at all: the Anthropic Messages API (and the Azure
 * Foundry Anthropic endpoint this app relays to) accept only PDF, plain text, and
 * images as content blocks — they cannot read raw .docx/.xlsx bytes. Every major
 * chat product extracts Office docs to text BEFORE the model sees them; this is
 * that step. The original bytes are still stored (re-downloadable from the chip);
 * only the extracted Markdown is ever sent to the model.
 *
 * Fidelity is honestly lossy and surfaced in UI copy:
 *   - Word (mammoth → turndown): headings, lists, tables, bold/italic, footnotes
 *     survive; headers/footers, tracked changes, comments, charts, and embedded
 *     images are dropped.
 *   - Excel (SheetJS): cached cell values only (no live formula recalculation in
 *     the community edition); merged cells expanded; each sheet a Markdown table.
 *
 * Two size governors keep a 4 MB workbook (which can hold ~500k rows — tiny in
 * bytes, enormous as text) from blowing the model context window or the daily
 * token gate: MAX_SHEET_ROWS caps rows per sheet, MAX_OFFICE_TEXT_CHARS caps the
 * whole extracted string. Over either cap = truncate-and-warn (a visible marker),
 * never a hard rejection — the user still gets a useful answer and the full
 * original stays re-downloadable.
 */
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { tables } from 'turndown-plugin-gfm'
import * as XLSX from 'xlsx'

/** Per-file extracted-text cap (≈28k tokens). The real governor for context/token
 * safety because the text is sticky and re-sent to the model every turn. */
export const MAX_OFFICE_TEXT_CHARS = 100 * 1024
/** Per-sheet data-row cap — bounds a runaway spreadsheet before MAX_OFFICE_TEXT_CHARS.
 * Sized so real operational sheets (rosters, schedules, logs) pass intact while a
 * pathological sheet is still bounded; MAX_OFFICE_TEXT_CHARS is the hard backstop. */
export const MAX_SHEET_ROWS = 1000

/** The two OOXML media types this module handles, mapped to a short format tag. */
export const OFFICE_FORMATS = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
}

/** The office media-type allowlist (the upload route's branch key). */
export const OFFICE_MEDIA_TYPES = new Set(Object.keys(OFFICE_FORMATS))

/** Format-specific OPC part that MUST be present in a valid file of that format.
 * `.docx`/`.xlsx`/`.pptx`/`.zip` all share the ZIP signature, so the signature
 * alone can't tell them apart — the OPC part is the discriminator (Decision 4). */
const OPC_PART = {
  word: 'word/document.xml',
  excel: 'xl/workbook.xml',
  // PowerPoint is NOT in OFFICE_FORMATS — decks take a separate render-to-PDF
  // pipeline (deck-convert.js), not text extraction. This entry exists only so
  // `assertOfficeStructure(buffer, 'powerpoint')` can gate a .pptx upload.
  powerpoint: 'ppt/presentation.xml',
}

/** ZIP local-file-header signature ("PK\x03\x04"). Every OOXML file starts here. */
const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/** Typed error for non-Office / corrupt / unparseable input; the route maps it to 400. */
export class OfficeExtractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OfficeExtractError'
  }
}

/** `'word' | 'excel' | null` for a media type (the office allowlist check). */
export function officeFormatFor(mediaType) {
  return OFFICE_FORMATS[mediaType] || null
}

/**
 * Structural gate (Decision 4): require the ZIP signature, then confirm the
 * format-specific OPC part is present. Entry names live UNCOMPRESSED in the ZIP
 * local headers / central directory, so a raw byte scan for the part name is a
 * reliable, parser-free discriminator (a `.pptx` or `.zip` mislabelled as docx
 * has neither part). Throws OfficeExtractError on a miss.
 */
export function assertOfficeStructure(buffer, format) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || !buffer.subarray(0, 4).equals(ZIP_SIG)) {
    throw new OfficeExtractError('Not a valid Office file (missing ZIP signature).')
  }
  const part = OPC_PART[format]
  if (!part || !buffer.includes(Buffer.from(part, 'latin1'))) {
    const label =
      { word: 'Word (.docx)', excel: 'Excel (.xlsx)', powerpoint: 'PowerPoint (.pptx)' }[format] || 'Office'
    throw new OfficeExtractError(`Not a valid ${label} file.`)
  }
}

/** Escape a cell value for a Markdown table cell: pipes and newlines would break
 * the row, so neutralise them while keeping the text readable. */
function escapeCell(value) {
  return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

/** Apply the per-file text cap: truncate-and-warn (Decision 10), never reject. */
function applyTextCap(text) {
  if (text.length <= MAX_OFFICE_TEXT_CHARS) return { text, truncated: false }
  const marker = '\n\n> content truncated'
  const sliced = text.slice(0, MAX_OFFICE_TEXT_CHARS - marker.length)
  return { text: sliced + marker, truncated: true }
}

/**
 * Make mammoth's table HTML render as a GFM Markdown table. Two fixes per table:
 *   1. Flatten cell paragraphs — mammoth wraps each cell's text in `<p>`, which
 *      turndown renders as block newlines inside the cell, breaking the row.
 *   2. Promote the first row's `<td>` to `<th>` — the GFM tables rule only emits
 *      a Markdown table when the first row is a heading row (all `<th>`);
 *      otherwise it keeps the raw HTML.
 * (Nested tables — rare from mammoth, already part of the documented fidelity
 * loss — are not handled specially.)
 */
function normalizeTables(html) {
  return html.replace(/<table[^>]*>[\s\S]*?<\/table>/g, (table) => {
    let t = table.replace(/<\/p>\s*<p[^>]*>/g, ' ').replace(/<\/?p[^>]*>/g, '')
    let done = false
    t = t.replace(/<tr[^>]*>[\s\S]*?<\/tr>/g, (tr) => {
      if (done) return tr
      done = true
      return tr.replace(/<td(\s[^>]*)?>/g, '<th$1>').replace(/<\/td>/g, '</th>')
    })
    return t
  })
}

/** Word: mammoth (docx → HTML) → turndown (HTML → Markdown). The GFM tables
 * plugin keeps table rows intact (plain turndown drops table structure). */
async function extractWord(buffer) {
  let html
  try {
    ;({ value: html } = await mammoth.convertToHtml({ buffer }))
  } catch (err) {
    throw new OfficeExtractError(`Could not read the Word document: ${err.message}`)
  }
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  turndown.use(tables)
  return turndown.turndown(normalizeTables(html || '')).trim()
}

/**
 * Build a Markdown table for one worksheet, expanding merged cells and capping
 * rows. Returns `{ md, truncated }`. The first row is treated as the header.
 */
function sheetToMarkdown(ws) {
  if (!ws || !ws['!ref']) return { md: '_(empty sheet)_', truncated: false }
  const range = XLSX.utils.decode_range(ws['!ref'])

  // Map every cell covered by a merge to its top-left (anchor) address, so a
  // merged title/value fills the whole spanned range instead of leaving blanks.
  const mergeAnchor = new Map()
  for (const m of ws['!merges'] || []) {
    const anchor = XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })
    for (let r = m.s.r; r <= m.e.r; r += 1) {
      for (let c = m.s.c; c <= m.e.c; c += 1) {
        mergeAnchor.set(XLSX.utils.encode_cell({ r, c }), anchor)
      }
    }
  }

  const cellText = (r, c) => {
    const addr = XLSX.utils.encode_cell({ r, c })
    const cell = ws[mergeAnchor.get(addr) || addr]
    if (!cell || cell.v == null) return '' // skip null cached values — no NaN/undefined leak
    return cell.w != null ? cell.w : String(cell.v) // .w = formatted (dates, raw:false)
  }

  const rowMd = (r) => {
    const cells = []
    for (let c = range.s.c; c <= range.e.c; c += 1) cells.push(escapeCell(cellText(r, c)))
    return `| ${cells.join(' | ')} |`
  }

  const colCount = range.e.c - range.s.c + 1
  const totalDataRows = range.e.r - range.s.r // rows after the header row
  const shown = Math.min(totalDataRows, MAX_SHEET_ROWS) // data rows actually emitted
  const lastRow = range.s.r + shown // header + `shown` data rows

  const lines = [rowMd(range.s.r), `| ${Array(colCount).fill('---').join(' | ')} |`]
  for (let r = range.s.r + 1; r <= lastRow; r += 1) lines.push(rowMd(r))

  const truncated = totalDataRows > MAX_SHEET_ROWS
  if (truncated) lines.push(`\n> showing ${MAX_SHEET_ROWS} of ${totalDataRows} rows`)
  return { md: lines.join('\n'), truncated, shown, total: totalDataRows }
}

/** Excel: every sheet emitted as `## Sheet: <name>` + a Markdown table. */
function extractExcel(buffer) {
  let wb
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  } catch (err) {
    throw new OfficeExtractError(`Could not read the Excel workbook: ${err.message}`)
  }
  const truncatedSheets = []
  const sections = wb.SheetNames.map((name) => {
    const { md, truncated: t, shown, total } = sheetToMarkdown(wb.Sheets[name])
    if (t) truncatedSheets.push({ name, shown, total })
    return `## Sheet: ${name}\n\n${md}`
  })
  return { text: sections.join('\n\n').trim(), truncated: truncatedSheets.length > 0, truncatedSheets }
}

/** Group thousands for human-readable counts in the truncation note (1000 → "1,000"). */
const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * A short, human-readable note describing what the model did NOT receive, so the
 * UI can tell the user their file was shortened (and that the downloaded original
 * is still complete). Returns '' when nothing was dropped.
 */
function buildTruncationNote({ truncatedSheets = [], textTruncated = false } = {}) {
  const parts = []
  if (truncatedSheets.length) {
    const list = truncatedSheets
      .map((s) => `"${s.name}" (first ${fmtNum(s.shown)} of ${fmtNum(s.total)} rows)`)
      .join(', ')
    parts.push(`${truncatedSheets.length > 1 ? 'Large sheets were' : 'A large sheet was'} shortened for the AI: ${list}.`)
  }
  if (textTruncated) {
    parts.push('This file is very long, so only the first ~100 KB of text was sent to the AI.')
  }
  if (!parts.length) return ''
  parts.push('The AI saw a shortened version; the original file you download is complete.')
  return parts.join(' ').slice(0, 800)
}

/**
 * Extract `{ buffer, mediaType, name }` to `{ format, text, truncated, truncationNote }`.
 * Structural validation runs first (clean rejection of a mislabelled ZIP/pptx),
 * then format-specific extraction, then the per-file text cap. `truncated` is true
 * when the row-cap or text-cap fired; `truncationNote` is a short human-readable
 * summary of what was dropped (drives the chip's "truncated" tooltip), '' otherwise.
 */
export async function extractOffice({ buffer, mediaType, name } = {}) {
  const format = officeFormatFor(mediaType)
  if (!format) {
    throw new OfficeExtractError(`Unsupported Office type: ${mediaType}.`)
  }
  assertOfficeStructure(buffer, format)

  let raw
  let rowTruncated = false
  let truncatedSheets = []
  if (format === 'word') {
    raw = await extractWord(buffer)
  } else {
    const out = extractExcel(buffer)
    raw = out.text
    rowTruncated = out.truncated
    truncatedSheets = out.truncatedSheets
  }

  if (!raw) {
    // A structurally valid but empty document — give the model something honest
    // rather than an empty block that reads as a failure.
    raw = `_(no extractable text in ${name || 'the file'})_`
  }

  const { text, truncated: textTruncated } = applyTextCap(raw)
  const truncated = rowTruncated || textTruncated
  const truncationNote = truncated ? buildTruncationNote({ truncatedSheets, textTruncated }) : ''
  return { format, text, truncated, truncationNote }
}
