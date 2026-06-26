/**
 * Attachment HTTP handlers (mounted behind requireAuth at /api/attachments).
 * This is the new ingestion trust boundary: image/PDF ONLY (text stays inline),
 * one file per request as base64 JSON, validated for allowlist + magic bytes +
 * the 4 MB cap, rate-limited per user, with a 6 MB body cap set at the mount.
 *
 * Identity is `req.user.sub`; object keys are username-prefixed inside the repo,
 * so a download/delete can only ever address the caller's own namespace.
 */
import { Router } from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { validateAttachmentBytes, validateOfficeBytes, sniffMediaType, ATTACHMENT_MAX_BYTES } from './message-content.js'
import { OFFICE_MEDIA_TYPES, extractOffice, OfficeExtractError } from './office-extract.js'
import { AttachmentCapError } from './attachments-repo.js'
import { isNotFound } from './object-store.js'
import { deckAttachmentsEnabled, PPTX_MEDIA_TYPE } from './deck-config.js'
import { convertDeckToPdf, DeckConvertError } from './deck-convert.js'
import { createAnthropicFiles, AnthropicFilesError } from './anthropic-files.js'

// Client-minted attachment ids (crypto.randomUUID); it becomes part of the
// object key, so bound it to a safe token (no '/', no '..').
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Per-user upload/delete limiter (~30/min), keyed by username + IP like
 * makeFeedbackLimiter. Bounds delete/re-upload amplification; downloads (GET) are
 * NOT limited so rendering a conversation with many historical images is fine.
 */
export function makeAttachmentLimiter(options = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.user.sub}:${ipKeyGenerator(req.ip || '0.0.0.0')}`,
    handler: (_req, res) =>
      res.status(429).json({ error: { message: 'Too many attachment requests. Please slow down.' } }),
    ...options,
  })
}

const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('attachments route error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: { message: 'Request failed. Please retry.' } })
  }
}

export function createAttachmentsRouter(
  { attachmentsRepo, anthropicFiles = createAnthropicFiles(null), convertDeck = convertDeckToPdf },
  { limiter = makeAttachmentLimiter() } = {},
) {
  const router = Router()

  // Upload one image/PDF. Text is never uploaded (it travels inline as a text part).
  router.post(
    '/',
    limiter,
    safe(async (req, res) => {
      const username = req.user.sub
      const { attachmentId, name, mediaType, base64 } = req.body || {}
      if (typeof attachmentId !== 'string' || !ID_RE.test(attachmentId)) {
        return res.status(400).json({ error: { message: 'Invalid attachment id.' } })
      }
      if (typeof mediaType !== 'string') {
        return res.status(400).json({ error: { message: 'mediaType is required.' } })
      }
      if (mediaType.startsWith('text/')) {
        return res.status(400).json({ error: { message: 'Text attachments are sent inline, not uploaded.' } })
      }

      // Office (.docx/.xlsx): store the original bytes (re-downloadable from the
      // chip) AND extract to Markdown server-side — the original is NEVER sent to
      // the model, only the extracted text is (sticky, by the content assembler).
      if (OFFICE_MEDIA_TYPES.has(mediaType)) {
        if (typeof base64 !== 'string' || base64.length === 0) {
          return res.status(400).json({ error: { message: 'Invalid attachment: missing bytes.' } })
        }
        const buffer = Buffer.from(base64, 'base64')
        if (buffer.length > ATTACHMENT_MAX_BYTES) {
          return res.status(413).json({ error: { message: 'Attachment is too large (max 4 MB).' } })
        }
        const verr = validateOfficeBytes({ mediaType, buffer })
        if (verr) return res.status(400).json({ error: { message: verr } })

        // Extract BEFORE storing so a corrupt/unparseable file is rejected without
        // orphaning an object (extraction is the final structural validator).
        let extracted
        try {
          extracted = await extractOffice({ buffer, mediaType, name: typeof name === 'string' ? name : '' })
        } catch (e) {
          if (e instanceof OfficeExtractError) return res.status(400).json({ error: { message: e.message } })
          throw e
        }

        try {
          const ref = await attachmentsRepo.putBytes({
            attachmentId,
            username,
            mediaType,
            size: buffer.length,
            name: typeof name === 'string' ? name : '',
            buffer,
          })
          return res.status(201).json({
            attachment: { ...ref, kind: 'office', format: extracted.format, text: extracted.text, truncated: extracted.truncated, truncationNote: extracted.truncationNote },
          })
        } catch (e) {
          if (e instanceof AttachmentCapError) {
            return res.status(413).json({ error: { message: e.message, code: e.code } })
          }
          throw e
        }
      }

      // Deck (.pptx): a VISUAL medium, so NOT text-extracted like office. Render to
      // a PDF server-side, upload that PDF to the Files API (vision), and store the
      // ORIGINAL .pptx for re-download. The PDF is INTERNAL — only the file_id is
      // kept; every user-facing surface shows the .pptx (see plan user story).
      if (mediaType === PPTX_MEDIA_TYPE) {
        if (!deckAttachmentsEnabled()) {
          return res.status(501).json({ error: { message: "PowerPoint attachments aren't enabled." } })
        }
        if (typeof base64 !== 'string' || base64.length === 0) {
          return res.status(400).json({ error: { message: 'Invalid attachment: missing bytes.' } })
        }
        const buffer = Buffer.from(base64, 'base64')
        if (buffer.length > ATTACHMENT_MAX_BYTES) {
          return res.status(413).json({ error: { message: 'Attachment is too large (max 4 MB).' } })
        }

        // 1. Convert FIRST — convertDeck validates structure + zip-bomb + page cap,
        //    so a bad/oversized deck is rejected WITHOUT storing anything (no orphan).
        let converted
        try {
          converted = await convertDeck(buffer, { name: typeof name === 'string' ? name : '' })
        } catch (e) {
          if (e instanceof DeckConvertError) {
            return res.status(e.status).json({ error: { message: e.message, code: e.code } })
          }
          throw e
        }

        // 2. Store the ORIGINAL .pptx (the only user-facing artifact).
        let ref
        try {
          ref = await attachmentsRepo.putBytes({
            attachmentId,
            username,
            mediaType,
            size: buffer.length,
            name: typeof name === 'string' ? name : '',
            buffer,
          })
        } catch (e) {
          if (e instanceof AttachmentCapError) {
            return res.status(413).json({ error: { message: e.message, code: e.code } })
          }
          throw e
        }

        // 3. Upload the derived PDF to the Files API (internal). On failure, roll back
        //    the stored original so we never leave a deck with no file_id.
        let fileId
        try {
          const pdfName = (typeof name === 'string' && name ? name : 'deck').replace(/\.pptx$/i, '')
          ;({ fileId } = await anthropicFiles.uploadPdf(converted.pdf, pdfName))
        } catch (e) {
          await attachmentsRepo
            .deleteBytes(attachmentId, username, buffer.length)
            .catch((cleanupErr) => console.error('deck rollback failed:', cleanupErr.message))
          if (e instanceof AnthropicFilesError) {
            return res.status(e.status).json({ error: { message: e.message, code: e.code } })
          }
          throw e
        }

        return res.status(201).json({
          attachment: { ...ref, kind: 'deck', pdfFileId: fileId, pageCount: converted.pageCount, truncated: false },
        })
      }

      const err = validateAttachmentBytes({ mediaType, base64 })
      if (err) return res.status(400).json({ error: { message: err } })

      const buffer = Buffer.from(base64, 'base64')
      if (buffer.length > ATTACHMENT_MAX_BYTES) {
        return res.status(413).json({ error: { message: 'Attachment is too large (max 4 MB).' } })
      }

      try {
        const ref = await attachmentsRepo.putBytes({
          attachmentId,
          username,
          mediaType,
          size: buffer.length, // trust the decoded bytes, not a client-claimed size
          name: typeof name === 'string' ? name : '',
          buffer,
        })
        const kind = mediaType === 'application/pdf' ? 'document' : 'image'
        res.status(201).json({ attachment: { ...ref, kind } })
      } catch (e) {
        if (e instanceof AttachmentCapError) {
          return res.status(413).json({ error: { message: e.message, code: e.code } })
        }
        throw e
      }
    }),
  )

  // Download bytes from the caller's own namespace. Content-Type is sniffed from
  // the magic number (only allowlisted, validated bytes are ever stored).
  router.get(
    '/:id',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid attachment id.' } })
      try {
        const buffer = await attachmentsRepo.getBytes(id, req.user.sub)
        res.setHeader('Content-Type', sniffMediaType(buffer) || 'application/octet-stream')
        res.setHeader('Cache-Control', 'private, max-age=3600')
        res.send(buffer)
      } catch (e) {
        if (isNotFound(e)) return res.status(404).json({ error: { message: 'Attachment not found.' } })
        throw e
      }
    }),
  )

  // Delete one attachment object from the caller's namespace. Size is unknown
  // here, so the counter decrement is skipped (bounded drift; the conversation-
  // delete path decrements precisely from the file-part sizes).
  router.delete(
    '/:id',
    limiter,
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid attachment id.' } })
      await attachmentsRepo.deleteBytes(id, req.user.sub)
      res.json({ ok: true })
    }),
  )

  return router
}
