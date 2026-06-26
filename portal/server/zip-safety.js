/**
 * Shared ZIP-safety helpers for UNTRUSTED uploaded archives. OOXML files
 * (`.xlsx`/`.docx`/`.pptx`) are ZIP containers, so every path that accepts such
 * bytes needs the same zip-bomb guard. This is a LEAF module (it imports only
 * `util-validate`) so both the app-runtime parser (`file-parse.js`) and the chat
 * deck converter (`deck-convert.js`) can share ONE implementation without a
 * circular import — `file-parse.js` historically owned these, and re-exports
 * them for back-compat so existing importers are unchanged.
 */
import { posIntOr } from './util-validate.js'

/**
 * Typed error for an unparseable / over-limit file. `status` lets the route map the
 * failure HTTP-faithfully (413 for a resource-limit hit, 400 for bad/unsupported
 * input) and `code` lets generated app code branch without string-matching.
 */
export class FileParseError extends Error {
  constructor(message, { status = 400, code = 'FILE_PARSE_ERROR' } = {}) {
    super(message)
    this.name = 'FileParseError'
    this.status = status
    this.code = code
  }
}

/** Zip-bomb guard: reject an OOXML archive whose declared decompressed size exceeds
 *  this. Generous so a real ~18 MB workbook (verbose XML inflates a lot) passes,
 *  while a bomb (decompresses to GBs) is rejected pre-decompression. Env:
 *  APP_PARSE_MAX_DECOMPRESSED_BYTES. */
export const MAX_DECOMPRESSED_BYTES = posIntOr(process.env.APP_PARSE_MAX_DECOMPRESSED_BYTES, 300 * 1024 * 1024)

/** ZIP local-file-header signature ("PK\x03\x04"). Every OOXML file (and any zip) starts here. */
const ZIP_LOCAL_SIG = [0x50, 0x4b, 0x03, 0x04]

/** True when the bytes ARE a zip container — independent of the declared type. SheetJS/
 *  mammoth/LibreOffice dispatch on these magic bytes, so a file mislabelled csv/xls can
 *  still be a zip. */
export function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && ZIP_LOCAL_SIG.every((b, i) => buffer[i] === b)
}

/**
 * Zip-bomb / decompressed-size guard (R8). Parses the ZIP End-Of-Central-Directory
 * + central-directory headers (dependency-free) and sums each entry's declared
 * UNCOMPRESSED size, rejecting once the running total exceeds `maxUncompressed` —
 * BEFORE SheetJS/mammoth/LibreOffice ever inflate the archive. ZIP64 (sizes/counts
 * at their 0xFFFF.. sentinels) is rejected outright: a legitimate Office file under
 * the upload cap never needs it, and a bomb that does is exactly what we refuse.
 * Throws FileParseError(status 413) on an over-cap or malformed archive.
 */
export function assertZipNotBomb(buffer, maxUncompressed = MAX_DECOMPRESSED_BYTES) {
  const EOCD_SIG = 0x06054b50
  const CDH_SIG = 0x02014b50
  const EOCD_MIN = 22
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN) return // too small to be a real archive; structure check owns this

  // The EOCD sits at the very end, after an optional ≤64 KB comment — scan backwards.
  let eocd = -1
  const earliest = Math.max(0, buffer.length - (EOCD_MIN + 0xffff))
  for (let i = buffer.length - EOCD_MIN; i >= earliest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new FileParseError('Malformed archive (no ZIP end-of-central-directory).')

  const cdCount = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (cdCount === 0xffff || cdOffset === 0xffffffff) {
    throw new FileParseError('File is too large to parse safely (ZIP64).', { status: 413, code: 'FILE_TOO_LARGE' })
  }

  let total = 0
  let p = cdOffset
  for (let n = 0; n < cdCount; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CDH_SIG) {
      throw new FileParseError('Malformed archive (bad ZIP central directory).')
    }
    const uncompressed = buffer.readUInt32LE(p + 24)
    if (uncompressed === 0xffffffff) {
      throw new FileParseError('File is too large to parse safely (ZIP64 entry).', { status: 413, code: 'FILE_TOO_LARGE' })
    }
    total += uncompressed
    if (total > maxUncompressed) {
      throw new FileParseError(
        `File is too large when decompressed (over ${Math.round(maxUncompressed / (1024 * 1024))} MB). Rejected to protect the server.`,
        { status: 413, code: 'FILE_TOO_LARGE' },
      )
    }
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    p += 46 + nameLen + extraLen + commentLen
  }
}
