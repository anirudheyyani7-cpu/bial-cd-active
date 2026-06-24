/**
 * Real OOXML fixtures for the Office-attachment tests. Builds genuine `.docx`
 * (via jszip, the same reader mammoth uses) and `.xlsx` (via SheetJS) byte
 * buffers so extraction/validation run against real structures, not mocks.
 */
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

export const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const EXCEL_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`
const PKG_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
const docXml = (body) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`

export const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
export const heading = (level, text) => `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
export const tableXml = `<w:tbl>
  <w:tr>${cell('Region')}${cell('Sales')}</w:tr>
  <w:tr>${cell('North')}${cell('100')}</w:tr>
</w:tbl>`

/** A real .docx buffer from a WordprocessingML `<w:body>` fragment. */
export async function makeDocx(body = para('hello'), { extraParts = {} } = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', PKG_RELS)
  zip.file('word/document.xml', docXml(body))
  for (const [p, c] of Object.entries(extraParts)) zip.file(p, c)
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** A real .xlsx buffer from `[{ name, aoa | ws, merges }]`. */
export function makeXlsx(sheets) {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = s.ws || XLSX.utils.aoa_to_sheet(s.aoa)
    if (s.merges) ws['!merges'] = s.merges
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/** An arbitrary ZIP (e.g. a mislabelled `.zip`/`.pptx`) for negative tests. */
export async function makeZip(files) {
  const zip = new JSZip()
  for (const [p, c] of Object.entries(files)) zip.file(p, c)
  return zip.generateAsync({ type: 'nodebuffer' })
}
