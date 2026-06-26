/**
 * App-runtime file parsing: bytes → STRUCTURED DATA for generated dashboards
 * (R1–R5, R8). PURE module — no Express, no DB, no object-store — so it is
 * trivially testable and runs identically inline or inside a worker thread.
 *
 * This is the *app runtime* path, PARALLEL to and deliberately separate from
 * office-extract.js (the chat-attachment → model-ready Markdown path, out of
 * scope here). It REUSES that module's read-only helpers (structure validation,
 * the Word→text extractor) so there is one Word/zip implementation, but emits a
 * different shape: tabular files become ROWS (arrays of objects keyed by column),
 * documents become TEXT.
 *
 *   - Excel (.xlsx/.xls) / CSV  → { kind:'spreadsheet', sheets, sheet, columns,
 *                                   rows, rowCount, totalRows, truncated, ... }
 *                                 multi-sheet aware: `sheets` lists every worksheet,
 *                                 `sheet` is the one parsed (requested or first).
 *   - Word (.docx)              → { kind:'document', format:'word', text, ... }
 *                                 (delegated to office-extract's extractOffice).
 *   - PDF                       → not yet (fast-follow; the only new untrusted parser).
 *
 * SAFETY (R8) is layered, because the input is UNTRUSTED uploaded bytes:
 *   1. file-size — bounded by the route (decoded-byte cap) BEFORE calling here.
 *   2. decompressed-size (zip-bomb) — assertZipNotBomb sums the ZIP central-directory
 *      uncompressed sizes and rejects an over-cap archive BEFORE any decompression.
 *   3. row/cell — the worksheet range is CLAMPED to MAX_PARSE_ROWS × MAX_PARSE_COLS,
 *      so we iterate a bounded box even if the sheet declares a 1M×16k grid
 *      (truncate-and-warn, never a silent partial).
 *   4. parse-time — enforced live by the WORKER wrapper (file-parse-runner.js), which
 *      runs this off the event loop under a hard wall-clock timeout. The caps above
 *      bound the common cases; the timer is the backstop for adversarial CPU input.
 */
import * as XLSX from 'xlsx'
import { posIntOr } from './util-validate.js'
import { assertOfficeStructure, extractOffice, OfficeExtractError } from './office-extract.js'
import { FileParseError, looksLikeZip, assertZipNotBomb } from './zip-safety.js'

// The zip-safety guard (+ its typed error) moved to a shared leaf module so the
// chat deck converter can reuse it without a circular import. Re-export here so
// existing importers (file-parse-runner.js, tests) keep importing from this path.
export { FileParseError, looksLikeZip, assertZipNotBomb, MAX_DECOMPRESSED_BYTES } from './zip-safety.js'

const EXCEL_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLS_TYPE = 'application/vnd.ms-excel'
const CSV_TYPE = 'text/csv'

/** Max DATA rows returned per sheet (header excluded). Bounds both parse work and
 *  the JSON response; over-cap = truncate-and-warn. Env: APP_PARSE_MAX_ROWS. */
export const MAX_PARSE_ROWS = posIntOr(process.env.APP_PARSE_MAX_ROWS, 50_000)
/** Max columns returned per sheet. Bounds a sheet that declares a pathological
 *  column range. Env: APP_PARSE_MAX_COLS. */
export const MAX_PARSE_COLS = posIntOr(process.env.APP_PARSE_MAX_COLS, 512)

/** Group thousands for human-readable counts in a truncation note (1000 → "1,000"). */
const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * Decide the parse strategy from the declared content-type, falling back to the
 * filename extension (browsers mislabel CSV as application/vnd.ms-excel or
 * text/plain). Returns 'xlsx' | 'xls' | 'csv' | 'word' | null (unsupported).
 */
export function parseKindFor(contentType, filename) {
  const ct = typeof contentType === 'string' ? contentType.toLowerCase().split(';')[0].trim() : ''
  const m = typeof filename === 'string' ? filename.toLowerCase().match(/\.[a-z0-9]+$/) : null
  const ext = m ? m[0] : ''
  // Extension wins for CSV: a .csv mislabelled as ms-excel/plain must still be CSV.
  if (ext === '.csv' || ct === CSV_TYPE) return 'csv'
  if (ext === '.xlsx' || ct === EXCEL_TYPE) return 'xlsx'
  if (ext === '.xls' || ct === XLS_TYPE) return 'xls'
  if (ext === '.docx' || ct === WORD_TYPE) return 'word'
  return null
}

/**
 * Resolve the effective header row, skipping leading rows that are a single FULL-WIDTH
 * horizontal merge — a title banner (e.g. A1:E1 = "Q3 Flight Operations"). Without this,
 * the banner's value (expanded across the merge) would become every column name and the
 * REAL header would be demoted to a data row — silent, unflagged garbage for a dashboard
 * keyed by column name. Conservative: only a merge spanning the entire used column width
 * counts as a banner, so a partial merge (a real merged header cell) is left intact.
 */
function effectiveHeaderRow(ws, range) {
  const merges = ws['!merges'] || []
  let headerR = range.s.r
  // Bounded by the row count; advances past stacked banners.
  for (let guard = 0; headerR < range.e.r && guard <= range.e.r - range.s.r; guard += 1) {
    const banner = merges.find((m) => m.s.r === headerR && m.s.c <= range.s.c && m.e.c >= range.e.c)
    if (!banner) break
    headerR = banner.e.r + 1
  }
  return headerR
}

/**
 * One worksheet → `{ columns, rows, rowCount, totalRows, totalCols, shownCols,
 * truncated }`. The first non-banner row is the header. The iterated box is CLAMPED to
 * MAX_PARSE_ROWS × MAX_PARSE_COLS so parse work is bounded regardless of the
 * sheet's declared `!ref` (a tiny file can claim a 1M×16k grid). Merged cells are
 * expanded to their anchor value (mirrors office-extract). Values keep their JS
 * type (numbers stay numeric for charts/KPIs); Dates become ISO strings; empty
 * cells become null so every row has the same keys.
 */
export function sheetToRows(ws) {
  const empty = { columns: [], rows: [], rowCount: 0, totalRows: 0, totalCols: 0, shownCols: 0, truncated: false }
  if (!ws || !ws['!ref']) return empty
  const range = XLSX.utils.decode_range(ws['!ref'])
  const startC = range.s.c
  const startR = effectiveHeaderRow(ws, range) // skip leading full-width merged title banners
  const totalCols = range.e.c - startC + 1
  const totalRows = Math.max(0, range.e.r - startR) // data rows (after the header)
  const endC = Math.min(range.e.c, startC + MAX_PARSE_COLS - 1)
  const shownRows = Math.min(totalRows, MAX_PARSE_ROWS)
  const lastR = startR + shownRows

  // Merge anchors, only within the clamped box (so a giant merge list can't blow up work).
  const mergeAnchor = new Map()
  for (const mrg of ws['!merges'] || []) {
    if (mrg.s.r > lastR || mrg.s.c > endC) continue
    const anchor = XLSX.utils.encode_cell({ r: mrg.s.r, c: mrg.s.c })
    for (let r = mrg.s.r; r <= Math.min(mrg.e.r, lastR); r += 1) {
      for (let c = mrg.s.c; c <= Math.min(mrg.e.c, endC); c += 1) {
        mergeAnchor.set(XLSX.utils.encode_cell({ r, c }), anchor)
      }
    }
  }

  const valueAt = (r, c) => {
    const addr = XLSX.utils.encode_cell({ r, c })
    const cell = ws[mergeAnchor.get(addr) || addr]
    if (!cell || cell.v == null) return null // null cached formula value / empty cell
    const v = cell.v
    if (v instanceof Date) return v.toISOString()
    return v // number | boolean | string preserved as-is
  }

  // Header row → de-duplicated, non-empty column names (stable, so row objects key cleanly).
  const columns = []
  const seen = new Map()
  for (let c = startC; c <= endC; c += 1) {
    const raw = valueAt(startR, c)
    let name = raw == null || String(raw).trim() === '' ? `Column ${c - startC + 1}` : String(raw).trim()
    if (seen.has(name)) {
      const next = seen.get(name) + 1
      seen.set(name, next)
      name = `${name} (${next})`
    } else {
      seen.set(name, 1)
    }
    columns.push(name)
  }

  const rows = []
  for (let r = startR + 1; r <= lastR; r += 1) {
    const obj = {}
    for (let i = 0; i < columns.length; i += 1) obj[columns[i]] = valueAt(r, startC + i)
    rows.push(obj)
  }

  const truncated = totalRows > shownRows || totalCols > columns.length
  return { columns, rows, rowCount: rows.length, totalRows, totalCols, shownCols: columns.length, truncated }
}

/** Human-readable note describing what the parse left out (drives a UI "truncated" hint). */
function buildParseTruncationNote({ sheet, rowCount, totalRows, totalCols, shownCols }) {
  const parts = []
  if (totalRows > rowCount) {
    parts.push(`Sheet "${sheet}" has ${fmtNum(totalRows)} rows; only the first ${fmtNum(rowCount)} were returned.`)
  }
  if (totalCols > shownCols) {
    parts.push(`Only the first ${fmtNum(shownCols)} of ${fmtNum(totalCols)} columns were returned.`)
  }
  if (!parts.length) return ''
  parts.push('Split the file or filter it down if you need the full data.')
  return parts.join(' ').slice(0, 800)
}

/**
 * Read a workbook (xlsx/xls/csv all go through XLSX.read) into the structured shape.
 *
 * Accepted limitation: SheetJS TYPE-INFERS CSV cells, so identifier-like columns with a
 * leading zero or '+' (ZIP/PIN/phone/SKU) are coerced to numbers and lose them ('007'→7).
 * Numeric coercion is intended — counts/amounts must stay numeric to feed charts/KPIs —
 * and an .xlsx keeps the original text when the column is text-formatted. This mirrors the
 * SheetJS cached-cell-value limitation already accepted for the chat extraction path.
 */
function parseSpreadsheet(buffer, requestedSheet) {
  let wb
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  } catch (err) {
    throw new FileParseError(`Could not read the spreadsheet: ${err.message}`)
  }
  const sheets = wb.SheetNames.slice()
  if (sheets.length === 0) throw new FileParseError('The spreadsheet has no worksheets.')

  let sheet = sheets[0]
  if (requestedSheet != null && requestedSheet !== '') {
    if (!sheets.includes(requestedSheet)) {
      throw new FileParseError(`Worksheet "${requestedSheet}" not found. Available: ${sheets.join(', ')}.`, {
        code: 'SHEET_NOT_FOUND',
      })
    }
    sheet = requestedSheet
  }

  const out = sheetToRows(wb.Sheets[sheet])
  const truncationNote = out.truncated ? buildParseTruncationNote({ sheet, ...out }) : ''
  return {
    kind: 'spreadsheet',
    sheets,
    sheet,
    columns: out.columns,
    rows: out.rows,
    rowCount: out.rowCount,
    totalRows: out.totalRows,
    truncated: out.truncated,
    truncationNote,
  }
}

/** Word (.docx) → text, delegated to the shared office extractor (one Word impl). */
async function parseWord(buffer, filename) {
  const { text, truncated, truncationNote } = await extractOffice({
    buffer,
    mediaType: WORD_TYPE,
    name: filename,
  })
  return { kind: 'document', format: 'word', text, truncated, truncationNote }
}

/**
 * Parse uploaded bytes into structured data. Async (the Word path awaits mammoth);
 * the spreadsheet path is synchronous CPU work that the worker wrapper bounds.
 *
 * @param {object}  args
 * @param {Buffer}  args.buffer       - the file bytes (size already capped by the route)
 * @param {string}  args.contentType  - declared MIME type
 * @param {string} [args.filename]    - original name (extension fallback for routing)
 * @param {string} [args.sheet]       - worksheet to parse (spreadsheets; default = first)
 * @returns {Promise<object>} the structured result (see module header)
 * @throws {FileParseError|OfficeExtractError}
 */
export async function parseFile({ buffer, contentType, filename, sheet } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new FileParseError('No file bytes to parse.')
  }
  const kind = parseKindFor(contentType, filename)
  if (!kind) {
    throw new FileParseError(
      `This file type can't be parsed into data: ${contentType || filename || 'unknown'}. Supported: Excel (.xlsx/.xls), CSV, Word (.docx).`,
      { status: 415, code: 'UNSUPPORTED_TYPE' },
    )
  }
  if (kind === 'xlsx') {
    assertOfficeStructure(buffer, 'excel') // clean rejection of a mislabelled zip/pptx
    assertZipNotBomb(buffer) // decompressed-size guard BEFORE SheetJS inflates
    return parseSpreadsheet(buffer, sheet)
  }
  if (kind === 'xls' || kind === 'csv') {
    // A file mislabelled csv/xls can still be a ZIP container, and XLSX.read dispatches on
    // MAGIC BYTES (not the declared type) — so a PK-signatured bomb reaches the zip parser
    // regardless of the routed kind. Run the decompressed-size guard whenever the bytes are
    // actually a zip, so the guard can't be skipped by relabelling. (The worker memory
    // ceiling in file-parse-runner.js is the backstop for a guard-evading bomb.)
    if (looksLikeZip(buffer)) assertZipNotBomb(buffer)
    return parseSpreadsheet(buffer, sheet) // OLE2 / plain text otherwise — size-capped upstream
  }
  // word
  assertOfficeStructure(buffer, 'word')
  assertZipNotBomb(buffer)
  return parseWord(buffer, filename)
}

export { OfficeExtractError }
