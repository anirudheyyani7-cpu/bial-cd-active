import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import {
  extractOffice,
  assertOfficeStructure,
  officeFormatFor,
  OfficeExtractError,
  MAX_OFFICE_TEXT_CHARS,
  MAX_SHEET_ROWS,
} from '../office-extract.js'
import { WORD_TYPE, EXCEL_TYPE, makeDocx, makeXlsx, para, heading, tableXml } from './officeFixtures.js'

describe('officeFormatFor', () => {
  it('maps the two OOXML media types and nothing else', () => {
    expect(officeFormatFor(WORD_TYPE)).toBe('word')
    expect(officeFormatFor(EXCEL_TYPE)).toBe('excel')
    expect(officeFormatFor('application/pdf')).toBeNull()
    expect(officeFormatFor('application/zip')).toBeNull()
  })
})

describe('Word extraction (mammoth → turndown)', () => {
  it('happy path: headings + a table → Markdown preserves heading levels and table rows', async () => {
    const buffer = await makeDocx(heading(1, 'Quarterly Report') + heading(2, 'Summary') + para('Revenue grew.') + tableXml)
    const { format, text } = await extractOffice({ buffer, mediaType: WORD_TYPE, name: 'q.docx' })
    expect(format).toBe('word')
    expect(text).toContain('# Quarterly Report')
    expect(text).toContain('## Summary')
    expect(text).toContain('Revenue grew.')
    // GFM table rows survive (plain turndown would flatten the table).
    expect(text).toContain('| Region | Sales |')
    expect(text).toContain('| North | 100 |')
  })

  it('lossy: a header part + a tracked deletion are absent; body text survives', async () => {
    const deletion = `<w:p><w:del w:id="1" w:author="qa"><w:r><w:delText>DELETED_PHRASE</w:delText></w:r></w:del></w:p>`
    const body = para('Body stays.') + deletion
    const header = `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>PAGE_HEADER_TEXT</w:t></w:r></w:p></w:hdr>`
    const buffer = await makeDocx(body, { extraParts: { 'word/header1.xml': header } })
    const { text } = await extractOffice({ buffer, mediaType: WORD_TYPE, name: 'h.docx' })
    expect(text).toContain('Body stays.')
    expect(text).not.toContain('PAGE_HEADER_TEXT') // headers are not extracted
    expect(text).not.toContain('DELETED_PHRASE') // tracked deletions are dropped
  })
})

describe('Excel extraction (SheetJS)', () => {
  it('single sheet: a date cell renders as a date, not a serial number', async () => {
    const buffer = makeXlsx([{ name: 'Data', aoa: [['When', 'What'], [new Date(Date.UTC(2024, 2, 15)), 'launch']] }])
    const { format, text } = await extractOffice({ buffer, mediaType: EXCEL_TYPE, name: 'd.xlsx' })
    expect(format).toBe('excel')
    expect(text).toContain('## Sheet: Data')
    expect(text).toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/) // a formatted date, e.g. 3/15/24
    expect(text).not.toMatch(/\b45366\b/) // the serial for 2024-03-15, must NOT leak
  })

  it('multi-sheet: three sheets → three ## Sheet sections in order', async () => {
    const buffer = makeXlsx([
      { name: 'Alpha', aoa: [['a'], [1]] },
      { name: 'Beta', aoa: [['b'], [2]] },
      { name: 'Gamma', aoa: [['c'], [3]] },
    ])
    const { text } = await extractOffice({ buffer, mediaType: EXCEL_TYPE, name: 'm.xlsx' })
    expect(text.indexOf('## Sheet: Alpha')).toBeLessThan(text.indexOf('## Sheet: Beta'))
    expect(text.indexOf('## Sheet: Beta')).toBeLessThan(text.indexOf('## Sheet: Gamma'))
  })

  it('merged cells: a merged title row expands across the spanned columns', async () => {
    const buffer = makeXlsx([
      {
        name: 'M',
        aoa: [['Title', null], ['x', 'y']],
        merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }],
      },
    ])
    const { text } = await extractOffice({ buffer, mediaType: EXCEL_TYPE, name: 'merge.xlsx' })
    expect(text).toContain('| Title | Title |') // expanded, not '| Title |  |'
  })

  it(`row-cap: a sheet over ${MAX_SHEET_ROWS} rows is capped + carries a truncation note with real counts`, async () => {
    const total = MAX_SHEET_ROWS + 50
    const aoa = [['n']]
    for (let i = 1; i <= total; i += 1) aoa.push([i])
    const buffer = makeXlsx([{ name: 'Big', aoa }])
    const { text, truncated, truncationNote } = await extractOffice({ buffer, mediaType: EXCEL_TYPE, name: 'big.xlsx' })
    expect(truncated).toBe(true)
    expect(text).toContain(`showing ${MAX_SHEET_ROWS} of ${total} rows`)
    expect(text).toContain(`| ${MAX_SHEET_ROWS} |`) // last kept data row
    expect(text).not.toContain(`| ${MAX_SHEET_ROWS + 1} |`) // first dropped data row
    // The human-readable note names the sheet and the real (thousands-grouped) counts.
    const grp = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    expect(truncationNote).toContain(`"Big" (first ${grp(MAX_SHEET_ROWS)} of ${grp(total)} rows)`)
    expect(truncationNote).toMatch(/download/i)
  })

  it('a small workbook is not truncated and carries no truncation note', async () => {
    const buffer = makeXlsx([{ name: 'Mini', aoa: [['a', 'b'], [1, 2]] }])
    const { truncated, truncationNote } = await extractOffice({ buffer, mediaType: EXCEL_TYPE, name: 'mini.xlsx' })
    expect(truncated).toBe(false)
    expect(truncationNote).toBe('')
  })

  it('null cached formula value is skipped — no undefined/NaN leak', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['label', 'calc']])
    ws['A2'] = { t: 's', v: 'row' }
    ws['B2'] = { t: 'n', f: 'A1+1' } // formula cell, no cached .v
    ws['!ref'] = 'A1:B2'
    const buffer = makeXlsx([{ name: 'F', ws }])
    const { text } = await extractOffice({ buffer, mediaType: EXCEL_TYPE, name: 'f.xlsx' })
    expect(text).not.toMatch(/undefined|NaN/)
    expect(text).toContain('| row |  |') // empty cell where the null formula value was
  })
})

describe('structural validation', () => {
  it('accepts a real docx/xlsx structure', async () => {
    const docx = await makeDocx(para('hi'))
    expect(() => assertOfficeStructure(docx, 'word')).not.toThrow()
    const xlsx = makeXlsx([{ name: 'S', aoa: [['a']] }])
    expect(() => assertOfficeStructure(xlsx, 'excel')).not.toThrow()
  })

  it('rejects a plain .zip, a .pptx-shaped zip, and a truncated/garbage file', async () => {
    const plainZip = await new JSZip().file('hello.txt', 'hi').generateAsync({ type: 'nodebuffer' })
    expect(() => assertOfficeStructure(plainZip, 'word')).toThrow(OfficeExtractError)

    const pptx = await new JSZip().file('ppt/presentation.xml', '<p/>').generateAsync({ type: 'nodebuffer' })
    expect(() => assertOfficeStructure(pptx, 'word')).toThrow(OfficeExtractError)

    expect(() => assertOfficeStructure(Buffer.from('not a zip at all'), 'excel')).toThrow(/ZIP signature/)
  })

  it('extractOffice surfaces a corrupt/mislabelled file as OfficeExtractError (not an empty string)', async () => {
    const plainZip = await new JSZip().file('hello.txt', 'hi').generateAsync({ type: 'nodebuffer' })
    await expect(extractOffice({ buffer: plainZip, mediaType: WORD_TYPE, name: 'x.docx' })).rejects.toThrow(OfficeExtractError)
    await expect(extractOffice({ buffer: plainZip, mediaType: 'image/png', name: 'x.png' })).rejects.toThrow(/Unsupported Office type/)
  })
})

describe('per-file text cap (truncate-and-warn)', () => {
  it('truncates a document past MAX_OFFICE_TEXT_CHARS and appends a marker, never exceeding the cap', async () => {
    const huge = 'A'.repeat(MAX_OFFICE_TEXT_CHARS + 50_000)
    const buffer = await makeDocx(para(huge))
    const { text, truncated } = await extractOffice({ buffer, mediaType: WORD_TYPE, name: 'huge.docx' })
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThanOrEqual(MAX_OFFICE_TEXT_CHARS)
    expect(text).toContain('> content truncated')
  })
})
