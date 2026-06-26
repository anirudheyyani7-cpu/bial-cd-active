/**
 * Message-content helpers: the server-side trust boundary for attachment bytes
 * and the neutral `parts[]` ⇄ Anthropic `content[]` transform.
 *
 * Two callers share `validateAttachmentBytes`: the existing per-block
 * `validateAttachments` (the /api/claude relay, content-block shaped) and the new
 * `POST /api/attachments` upload route. Extracting it here keeps the allowlist +
 * magic-number + WebP form-type checks in ONE place — the client accept/type
 * checks are advisory and bypassable; this is the real check.
 *
 * `parts[]` is the provider-neutral stored shape (Decision 2); `partsToContent`
 * transforms it to Anthropic `content[]` at the edge. The plan keeps request
 * assembly client-side for now (Decision 6), so this server copy is exercised by
 * tests and ready for the server-side-assembly follow-up.
 *
 * Office (.docx/.xlsx) attachments are a hybrid: the original bytes are stored
 * (image/PDF-style) but NEVER inlined to the model — instead the server extracts
 * them to Markdown (office-extract.js) and that text is sent as a sticky text
 * block. They are validated by STRUCTURE (ZIP signature + OPC part), not by a
 * magic-byte map, so they live in their own allowlist (`OFFICE_MEDIA_TYPES`),
 * kept distinct from the image/PDF `ALLOWED_MEDIA`.
 */
import { OFFICE_MEDIA_TYPES, officeFormatFor, assertOfficeStructure, OfficeExtractError } from './office-extract.js'
import { PPTX_MEDIA_TYPE } from './deck-config.js'

export { OFFICE_MEDIA_TYPES }

/**
 * Deck (.pptx) media types. Kept DISTINCT from `OFFICE_MEDIA_TYPES` (the office
 * text-extraction allowlist) and from `ALLOWED_MEDIA` (the image/PDF magic-byte
 * allowlist): a deck is rendered to a PDF and sent to the model as a vision
 * `document` block referencing a Files-API `file_id` — a different pipeline from
 * both. The original `.pptx` is the only user-facing artifact.
 */
export const DECK_MEDIA_TYPES = new Set([PPTX_MEDIA_TYPE])

/**
 * Allowlisted attachment media types → the magic-number prefix the decoded bytes
 * must start with. WebP is a RIFF container ("RIFF"…"WEBP"); the leading "RIFF"
 * is checked here and the "WEBP" form-type at offset 8 separately.
 */
export const ALLOWED_MEDIA = {
  'image/png': [0x89, 0x50, 0x4e, 0x47], // \x89PNG
  'image/jpeg': [0xff, 0xd8], // \xFF\xD8
  'image/gif': [0x47, 0x49, 0x46, 0x38], // GIF8
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
}

// Upper bound on a single inlined text-attachment block (≈512 KB). The client
// caps text files at 256 KB but that's bypassable; this is the real bound.
export const TEXT_BLOCK_MAX_CHARS = 512 * 1024

// Per-file binary (image/PDF) cap. The upload route enforces this; the
// /api/claude relay stays body-limit-bounded (size omitted → cap not applied)
// to preserve its existing behaviour.
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024

function magicMatches(bytes, magic) {
  if (bytes.length < magic.length) return false
  return magic.every((b, i) => bytes[i] === b)
}

/**
 * Validate ONE binary (image/PDF) attachment's bytes against the allowlist +
 * magic number (+ WebP form-type, + the size cap when `size` is provided).
 * Returns an error message string on the first violation, or null when valid.
 * Shared by the /api/claude relay (per content block, no size) and the upload
 * route (with size).
 */
export function validateAttachmentBytes({ mediaType, base64, size } = {}) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    return 'Invalid attachment: missing bytes.'
  }
  const magic = ALLOWED_MEDIA[mediaType]
  if (!magic) {
    return `Unsupported attachment type: ${mediaType}. Allowed: PNG, JPEG, GIF, WebP, PDF.`
  }
  if (Number.isFinite(size) && size > ATTACHMENT_MAX_BYTES) {
    return `Attachment is too large (max ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB).`
  }
  const prefix = Buffer.from(base64.slice(0, 24), 'base64') // 24 b64 chars → 18 bytes, plenty
  if (!magicMatches(prefix, magic)) {
    return `Attachment bytes do not match the declared type ${mediaType}.`
  }
  // WebP's leading "RIFF" also matches WAV/AVI, so additionally require the
  // "WEBP" form-type at offset 8.
  if (mediaType === 'image/webp' && prefix.toString('latin1', 8, 12) !== 'WEBP') {
    return 'Attachment bytes do not match the declared type image/webp.'
  }
  return null
}

/**
 * Validate an Office (.docx/.xlsx) upload's decoded bytes by STRUCTURE: the type
 * must be in the office allowlist, and the bytes must be a ZIP carrying the
 * format-specific OPC part (delegated to office-extract's `assertOfficeStructure`
 * — Decision 4). Returns an error message string on the first violation, or null.
 * Extraction (office-extract) is the final structural validator; this is the fast
 * gate so a mislabelled `.zip`/`.pptx` is a clean 400 before any parse.
 */
export function validateOfficeBytes({ mediaType, buffer } = {}) {
  if (!officeFormatFor(mediaType)) {
    return `Unsupported attachment type: ${mediaType}.`
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return 'Invalid attachment: missing bytes.'
  }
  try {
    assertOfficeStructure(buffer, officeFormatFor(mediaType))
  } catch (err) {
    if (err instanceof OfficeExtractError) return err.message
    throw err
  }
  return null
}

/**
 * Validate every attachment content block in an Anthropic-shaped `messages`
 * array (the /api/claude relay). Returns an error string on the first violation,
 * or null. String content (no attachments) is skipped. Delegates the binary
 * byte check to `validateAttachmentBytes`; keeps the text-block size cap and the
 * block-type ↔ media-type pairing check here (both content-block specific).
 */
export function validateAttachments(messages) {
  if (!Array.isArray(messages)) return null
  for (const msg of messages) {
    const content = msg?.content
    if (!Array.isArray(content)) continue // string content = no attachments
    for (const block of content) {
      if (block?.type === 'text') {
        if (typeof block.text !== 'string') return 'Invalid attachment: malformed text block.'
        if (Buffer.byteLength(block.text, 'utf8') > TEXT_BLOCK_MAX_CHARS) {
          return 'A text attachment is too large. Please trim the file and try again.'
        }
        continue
      }
      if (block?.type !== 'image' && block?.type !== 'document') continue
      const src = block.source
      // Deck: a `document` block referencing a Files-API `file_id` (the internal
      // converted PDF). There are no bytes to magic-check — validate the reference
      // shape and an optional ephemeral cache_control, then accept.
      if (block.type === 'document' && src?.type === 'file') {
        if (typeof src.file_id !== 'string' || src.file_id.length === 0 || src.file_id.length > 256) {
          return 'Invalid attachment: malformed document file reference.'
        }
        if (
          block.cache_control !== undefined &&
          (block.cache_control === null ||
            typeof block.cache_control !== 'object' ||
            block.cache_control.type !== 'ephemeral')
        ) {
          return 'Invalid attachment: malformed cache control.'
        }
        continue
      }
      if (!src || src.type !== 'base64' || typeof src.data !== 'string') {
        return 'Invalid attachment: malformed source.'
      }
      // Enforce block.type ↔ media_type so a mismatch is a clean 400 here rather
      // than an upstream rejection after the relay commits.
      const isPdf = src.media_type === 'application/pdf'
      if (block.type === 'document' && !isPdf) {
        return `A document attachment must be a PDF, not ${src.media_type}.`
      }
      if (block.type === 'image' && isPdf) {
        return 'An image attachment must be an image type, not application/pdf.'
      }
      const err = validateAttachmentBytes({ mediaType: src.media_type, base64: src.data })
      if (err) return err
    }
  }
  return null
}

/**
 * Reverse-lookup the media type of stored bytes from their magic number, so the
 * download route can set a correct Content-Type without storing it separately.
 * Reliable because only allowlisted, magic-validated bytes are ever stored.
 */
export function sniffMediaType(buffer) {
  if (!buffer || buffer.length === 0) return null
  for (const [mediaType, magic] of Object.entries(ALLOWED_MEDIA)) {
    if (!magicMatches(buffer, magic)) continue
    if (mediaType === 'image/webp' && buffer.toString('latin1', 8, 12) !== 'WEBP') continue
    return mediaType
  }
  return null
}

/** Strip characters from a filename that could break out of the `name="..."`
 * attribute (quotes, angle brackets, newlines) before it goes into the fence. */
export function sanitizeFenceName(name) {
  return String(name || '').replace(/[\r\n"<>]/g, ' ').slice(0, 200)
}

/** Neutralise any literal `</attachment>` inside fenced DATA so attacker-controlled
 * content can't close the fence early and have the rest read as instructions. */
export function neutralizeFence(text) {
  return String(text || '').replace(/<\/(attachment)/gi, '<\\/$1')
}

/** The model-facing fence for an office part's extracted text (Decision 3): the
 * Markdown is wrapped as DATA so the model never reads it as instructions. Both
 * the filename and the content are sanitised so neither can break the fence. */
export function officeFence(part) {
  return `<attachment name="${sanitizeFenceName(part.name)}" type="${part.format}">\n${neutralizeFence(part.text)}\n</attachment>`
}

/**
 * Transform a neutral `parts[]` array into an Anthropic `content[]` (or a plain
 * string when no file/attachment blocks are emitted — the unchanged path).
 *
 * - Text parts (including inline csv/txt attachments) are STICKY: always emitted.
 * - Office file parts are STICKY too, but as a TEXT block carrying the extracted
 *   Markdown (fenced as data) — the original bytes are NEVER inlined to the model
 *   (Decisions 2, 3, 8). Emitted on every turn, regardless of `binary`.
 * - Deck (.pptx) file parts are STICKY as a vision `document` block referencing the
 *   internal Files-API PDF by `file_id` (+ `cache_control`); emitted every turn,
 *   regardless of `binary`. No base64; the user-facing artifact is the .pptx.
 * - Image/PDF file parts are emitted ONLY when `binary` is true (the newest
 *   turn), with bytes supplied by `getBase64(part)`; on older turns they're
 *   dropped (the model already saw them) so the request body stays bounded.
 * - File blocks come BEFORE the prose text block (Anthropic ordering).
 */
export function partsToContent(parts, { binary = true, getBase64 } = {}) {
  if (!Array.isArray(parts)) return ''
  const prose = []
  const blocks = []
  for (const p of parts) {
    if (p?.type === 'file' && p.kind === 'office') {
      // Sticky extracted text — every turn, never the original bytes.
      blocks.push({ type: 'text', text: officeFence(p) })
      continue
    }
    if (p?.type === 'file' && p.kind === 'deck') {
      // STICKY vision document block referencing the INTERNAL Files-API PDF by
      // file_id (cheap to re-send every turn, cheap to re-read under the cache;
      // cache_control makes follow-ups ~0.1x). No base64 ever touches this path,
      // and the user-facing artifact stays the original .pptx.
      if (p.pdfFileId) {
        blocks.push({
          type: 'document',
          source: { type: 'file', file_id: p.pdfFileId },
          cache_control: { type: 'ephemeral' },
        })
      }
      continue
    }
    if (p?.type === 'file') {
      if (!binary) continue // historical binary dropped — the model already saw it
      const data = getBase64?.(p)
      if (!data) continue // bytes unavailable → skip rather than send a null-data block
      if (p.kind === 'document' || p.mediaType === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })
      } else {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data } })
      }
      continue
    }
    if (p?.type === 'text' && typeof p.text === 'string') prose.push(p.text)
  }
  const text = prose.join('\n')
  if (blocks.length === 0) return text // no emitted file blocks → plain string
  blocks.push({ type: 'text', text }) // prose after files (Anthropic ordering)
  return blocks
}

/** Plain text from a `parts[]` (display/transcript). */
export function partsToText(parts) {
  if (!Array.isArray(parts)) return typeof parts === 'string' ? parts : ''
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
}
