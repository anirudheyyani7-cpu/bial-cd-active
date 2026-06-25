import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import {
  parseFile,
  parseKindFor,
  sheetToRows,
  assertZipNotBomb,
  FileParseError,
  OfficeExtractError,
  MAX_PARSE_ROWS,
  MAX_PARSE_COLS,
} from '../file-parse.js'
import { WORD_TYPE, EXCEL_TYPE, makeXlsx, makeDocx, para, heading } from './officeFixtures.js'

const CSV_TYPE = 'text/csv'
const XLS_TYPE = 'application/vnd.ms-excel'

describe('parseKindFor', () => {
  it('routes by content-type', () => {
    expect(parseKindFor(EXCEL_TYPE, 'x')).toBe('xlsx')
    expect(parseKindFor(XLS_TYPE, 'x')).toBe('xls')
    expect(parseKindFor(CSV_TYPE, 'x')).toBe('csv')
    expect(parseKindFor(WORD_TYPE, 'x')).toBe('word')
    expect(parseKindFor('application/pdf', 'x.pdf')).toBeNull()
    expect(parseKindFor('image/png', 'x.png')).toBeNull()
  })

  it('falls back to the filename extension and prefers CSV for a mislabelled csv', () => {
    expect(parseKindFor('', 'data.xlsx')).toBe('xlsx')
    expect(parseKindFor('', 'data.docx')).toBe('word')
    // Browsers commonly send .csv as application/vnd.ms-excel or text/plain.
    expect(parseKindFor(XLS_TYPE, 'data.csv')).toBe('csv')
    expect(parseKindFor('text/plain', 'data.csv')).toBe('csv')
  })
})

describe('spreadsheet → rows (xlsx)', () => {
  it('returns objects keyed by header, preserving number type and ISO dates', async () => {
    const buffer = makeXlsx([
      {
        name: 'Flights',
        aoa: [
          ['Destination', 'Passengers', 'When'],
          ['DEL', 220, new Date(Date.UTC(2024, 2, 15))],
          ['BOM', 180, new Date(Date.UTC(2024, 2, 16))],
        ],
      },
    ])
    const out = await parseFile({ buffer, contentType: EXCEL_TYPE, filename: 'flights.xlsx' })
    expect(out.kind).toBe('spreadsheet')
    expect(out.sheets).toEqual(['Flights'])
    expect(out.sheet).toBe('Flights')
    expect(out.columns).toEqual(['Destination', 'Passengers', 'When'])
    expect(out.rowCount).toBe(2)
    expect(out.rows[0].Destination).toBe('DEL')
    expect(out.rows[0].Passengers).toBe(220) // number stays numeric for charts/KPIs
    expect(typeof out.rows[0].Passengers).toBe('number')
    // Date → ISO string. SheetJS reconstructs the Date in the runner's local TZ, so
    // assert the ISO shape + date (±1 day) rather than a TZ-fragile exact instant.
    expect(out.rows[0].When).toMatch(/^2024-03-1[45]T[\d:.]+Z$/)
    expect(out.truncated).toBe(false)
  })

  it('is multi-sheet aware: lists every worksheet and parses the requested one', async () => {
    const buffer = makeXlsx([
      { name: 'Alpha', aoa: [['a'], [1]] },
      { name: 'Beta', aoa: [['b'], [2]] },
      { name: 'Gamma', aoa: [['c'], [3]] },
    ])
    const first = await parseFile({ buffer, contentType: EXCEL_TYPE, filename: 'm.xlsx' })
    expect(first.sheets).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(first.sheet).toBe('Alpha') // default = first
    expect(first.columns).toEqual(['a'])

    const chosen = await parseFile({ buffer, contentType: EXCEL_TYPE, filename: 'm.xlsx', sheet: 'Beta' })
    expect(chosen.sheet).toBe('Beta')
    expect(chosen.rows).toEqual([{ b: 2 }])
  })

  it('rejects an unknown worksheet name with SHEET_NOT_FOUND', async () => {
    const buffer = makeXlsx([{ name: 'Only', aoa: [['x'], [1]] }])
    await expect(parseFile({ buffer, contentType: EXCEL_TYPE, filename: 'o.xlsx', sheet: 'Missing' })).rejects.toMatchObject({
      name: 'FileParseError',
      code: 'SHEET_NOT_FOUND',
    })
  })

  it('de-duplicates duplicate headers and synthesises names for blank header cells', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Name', null],
      ['a', 'b', 'c'],
    ])
    const out = sheetToRows(ws)
    expect(out.columns).toEqual(['Name', 'Name (2)', 'Column 3'])
    expect(out.rows[0]).toEqual({ Name: 'a', 'Name (2)': 'b', 'Column 3': 'c' })
  })

  it('skips a full-width merged title banner and uses the real header row', async () => {
    const buffer = makeXlsx([
      {
        name: 'Report',
        aoa: [
          ['Q3 2024 Flight Operations', null, null], // row 1: merged title banner
          ['Destination', 'Passengers', 'Gate'], // row 2: the REAL header
          ['DEL', 220, 'A1'],
          ['BOM', 180, 'B2'],
        ],
        merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }], // A1:C1 banner spans the full width
      },
    ])
    const out = await parseFile({ buffer, contentType: EXCEL_TYPE, filename: 'r.xlsx' })
    expect(out.columns).toEqual(['Destination', 'Passengers', 'Gate']) // not the banner text
    expect(out.rows).toEqual([
      { Destination: 'DEL', Passengers: 220, Gate: 'A1' },
      { Destination: 'BOM', Passengers: 180, Gate: 'B2' },
    ])
    expect(out.rowCount).toBe(2)
  })

  it('leaves a PARTIAL merged header cell intact (only a full-width banner is skipped)', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Span', null, 'Solo'], // A1:B1 merged, C1 its own — NOT a full-width banner
      ['x', 'y', 'z'],
    ])
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
    const out = sheetToRows(ws)
    expect(out.columns).toEqual(['Span', 'Span (2)', 'Solo']) // row 1 still the header
    expect(out.rows).toEqual([{ Span: 'x', 'Span (2)': 'y', Solo: 'z' }])
  })

  it('represents empty cells as null so every row has the same keys', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['x', 'y'],
      ['only-x', null],
    ])
    const out = sheetToRows(ws)
    expect(out.rows[0]).toEqual({ x: 'only-x', y: null })
  })

  it('clamps columns past MAX_PARSE_COLS and flags truncation with a note', () => {
    const wide = MAX_PARSE_COLS + 1
    const header = Array.from({ length: wide }, (_, i) => `c${i}`)
    const ws = XLSX.utils.aoa_to_sheet([header, header.map((_, i) => i)])
    const out = sheetToRows(ws)
    expect(out.columns).toHaveLength(MAX_PARSE_COLS)
    expect(out.totalCols).toBe(wide)
    expect(out.truncated).toBe(true)
  })

  it(`clamps rows past MAX_PARSE_ROWS (truncate-and-warn)`, async () => {
    const total = MAX_PARSE_ROWS + 5
    const aoa = [['n']]
    for (let i = 1; i <= total; i += 1) aoa.push([i])
    const buffer = makeXlsx([{ name: 'Big', aoa }])
    const out = await parseFile({ buffer, contentType: EXCEL_TYPE, filename: 'big.xlsx' })
    expect(out.rowCount).toBe(MAX_PARSE_ROWS)
    expect(out.totalRows).toBe(total)
    expect(out.truncated).toBe(true)
    expect(out.truncationNote).toMatch(/rows/)
  })
})

describe('spreadsheet → rows (csv)', () => {
  it('parses CSV bytes into rows with a single Sheet1', async () => {
    const buffer = Buffer.from('Destination,Passengers\nDEL,220\nBOM,180\n', 'utf8')
    const out = await parseFile({ buffer, contentType: CSV_TYPE, filename: 'flights.csv' })
    expect(out.kind).toBe('spreadsheet')
    expect(out.sheets).toHaveLength(1)
    expect(out.columns).toEqual(['Destination', 'Passengers'])
    expect(out.rows).toEqual([
      { Destination: 'DEL', Passengers: 220 },
      { Destination: 'BOM', Passengers: 180 },
    ])
  })
})

describe('document → text (word)', () => {
  it('extracts Word text (delegated to the shared office extractor)', async () => {
    const buffer = await makeDocx(heading(1, 'Runway Report') + para('All clear.'))
    const out = await parseFile({ buffer, contentType: WORD_TYPE, filename: 'r.docx' })
    expect(out.kind).toBe('document')
    expect(out.format).toBe('word')
    expect(out.text).toContain('# Runway Report')
    expect(out.text).toContain('All clear.')
  })
})

describe('zip-bomb / decompressed-size guard', () => {
  it('rejects an archive whose declared uncompressed size exceeds the cap', async () => {
    // ~2 MB of a single byte: compresses to a few KB, but the ZIP central directory
    // still records the real 2 MB uncompressed size.
    const buffer = await new JSZip()
      .file('big.bin', 'A'.repeat(2 * 1024 * 1024))
      .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    let caught
    try {
      assertZipNotBomb(buffer, 1024 * 1024) // 1 MB cap < 2 MB declared
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileParseError)
    expect(caught.status).toBe(413)
    expect(caught.code).toBe('FILE_TOO_LARGE')
  })

  it('passes a normal small workbook under the default cap', () => {
    const buffer = makeXlsx([{ name: 'S', aoa: [['a', 'b'], [1, 2]] }])
    expect(() => assertZipNotBomb(buffer)).not.toThrow()
  })

  it('rejects a non-archive with a malformed-archive error', () => {
    expect(() => assertZipNotBomb(Buffer.from('this is plainly not a zip archive at all'))).toThrow(/Malformed archive/)
  })

  it('engages on a PK-signatured buffer even when mislabelled csv/xls (no relabel bypass)', async () => {
    // A buffer that starts with the ZIP signature but is not a valid archive. XLSX.read
    // would still byte-sniff PK→read_zip, so the guard MUST run on the csv/xls branch too;
    // proven by the guard's own "Malformed archive" rejection rather than a SheetJS error.
    const pkNoEocd = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)])
    await expect(parseFile({ buffer: pkNoEocd, contentType: 'text/csv', filename: 'evil.csv' })).rejects.toThrow(/Malformed archive/)
    await expect(parseFile({ buffer: pkNoEocd, contentType: 'application/vnd.ms-excel', filename: 'evil.bin' })).rejects.toThrow(
      /Malformed archive/,
    )
  })
})

describe('input validation', () => {
  it('rejects empty bytes', async () => {
    await expect(parseFile({ buffer: Buffer.alloc(0), contentType: EXCEL_TYPE, filename: 'e.xlsx' })).rejects.toBeInstanceOf(
      FileParseError,
    )
  })

  it('rejects an unsupported type cleanly (415)', async () => {
    await expect(parseFile({ buffer: Buffer.from('%PDF-1.4'), contentType: 'application/pdf', filename: 'd.pdf' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_TYPE',
      status: 415,
    })
  })

  it('rejects a plain zip mislabelled as .xlsx (structure check)', async () => {
    const plainZip = await new JSZip().file('hello.txt', 'hi').generateAsync({ type: 'nodebuffer' })
    await expect(parseFile({ buffer: plainZip, contentType: EXCEL_TYPE, filename: 'x.xlsx' })).rejects.toBeInstanceOf(
      OfficeExtractError,
    )
  })
})
