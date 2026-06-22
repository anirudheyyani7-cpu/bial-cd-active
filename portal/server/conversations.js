/**
 * Conversation + message HTTP handlers (mounted behind requireAuth at
 * /api/conversations). Identity is ALWAYS `req.user.sub` — the body's username,
 * if any, is ignored. Every read/write is scoped to that user, so a guessed
 * conversation id from another account reads/writes nothing.
 *
 * The header upsert + message insert happen in ONE POST so an assistant turn can
 * never reference a header-less conversation (U10). The header upsert is filtered
 * by `{ _id, username }`; a cross-user id collision surfaces as a 409, never a
 * silent overwrite of another user's header (write-IDOR closed).
 *
 * Mirrors feedback.js: pure-ish validation + thin handlers over injected repos.
 */
import { Router } from 'express'
import { TEXT_BLOCK_MAX_CHARS } from './message-content.js'

const KINDS = new Set(['planning', 'assistant', 'builder'])
// Client-minted ids are crypto.randomUUID(); bound the shape defensively.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function validateParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return 'message.parts must be a non-empty array'
  for (const p of parts) {
    if (!p || typeof p !== 'object') return 'message.parts contains an invalid entry'
    if (p.type === 'text') {
      if (typeof p.text !== 'string') return 'a text part must carry a string'
      if (Buffer.byteLength(p.text, 'utf8') > TEXT_BLOCK_MAX_CHARS) return 'a text part is too large'
    } else if (p.type === 'file') {
      if (typeof p.attachmentId !== 'string' || !ID_RE.test(p.attachmentId)) return 'a file part has an invalid attachmentId'
      if (p.kind !== 'image' && p.kind !== 'document') return 'a file part has an invalid kind'
      if (typeof p.mediaType !== 'string') return 'a file part has an invalid mediaType'
    } else {
      return `unsupported part type: ${p.type}`
    }
  }
  return null
}

function validateMessageInput(m) {
  if (!m || typeof m !== 'object') return 'message is required'
  if (typeof m._id !== 'string' || !ID_RE.test(m._id)) return 'message._id is invalid'
  if (m.role !== 'user' && m.role !== 'assistant') return 'message.role must be user or assistant'
  if (!Number.isFinite(m.seq)) return 'message.seq must be a number'
  return validateParts(m.parts)
}

/** A builder code snapshot must be `{ source, entry, createdAt?, model? }`. */
function validateCodeSnapshot(code) {
  if (!code || typeof code !== 'object') return 'code must be an object'
  if (typeof code.source !== 'string' || code.source.length === 0) return 'code.source is required'
  if (typeof code.entry !== 'string' || code.entry.length === 0) return 'code.entry is required'
  return null
}

/** Wrap an async handler so an unexpected throw becomes a clean 500, never a leak. */
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('conversations route error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: { message: 'Request failed. Please retry.' } })
  }
}

export function createConversationsRouter({ conversationsRepo, messagesRepo, attachmentsRepo }) {
  const router = Router()

  // List the caller's conversation headers, optionally filtered by kind.
  router.get(
    '/',
    safe(async (req, res) => {
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined
      if (kind && !KINDS.has(kind)) return res.status(400).json({ error: { message: 'Unknown kind.' } })
      const conversations = await conversationsRepo.listByUser(req.user.sub, kind)
      res.json({ conversations })
    }),
  )

  // Header + ordered messages for one conversation the caller owns.
  router.get(
    '/:id',
    safe(async (req, res) => {
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid conversation id.' } })
      const conversation = await conversationsRepo.getHeader(id, req.user.sub)
      if (!conversation) return res.status(404).json({ error: { message: 'Conversation not found.' } })
      const messages = await messagesRepo.listByConversation(id, req.user.sub)
      res.json({ conversation, messages })
    }),
  )

  // Upsert the header (owner from token) AND insert one message, atomically per
  // call so an assistant turn never lands on a header-less conversation.
  router.post(
    '/:id/messages',
    safe(async (req, res) => {
      const username = req.user.sub
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid conversation id.' } })
      const { message, header } = req.body || {}
      const msgErr = validateMessageInput(message)
      if (msgErr) return res.status(400).json({ error: { message: msgErr } })
      if (!header || !KINDS.has(header.kind)) {
        return res.status(400).json({ error: { message: 'header.kind must be planning, assistant, or builder.' } })
      }

      try {
        await conversationsRepo.upsertHeader({
          _id: id,
          username, // owner from the token, never the body
          kind: header.kind,
          title: typeof header.title === 'string' ? header.title : undefined,
          context: header.context, // builder generation settings; opaque
          createdAt: typeof header.createdAt === 'string' ? header.createdAt : undefined,
        })
      } catch (err) {
        if (err?.code === 11000) {
          return res.status(409).json({ error: { message: 'Conversation id already in use.' } })
        }
        throw err
      }

      const doc = {
        _id: message._id,
        conversationId: id,
        username,
        role: message.role,
        schemaVersion: Number.isFinite(message.schemaVersion) ? message.schemaVersion : 1,
        parts: message.parts,
        seq: message.seq, // client-minted sort key, stored verbatim
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
      }
      await messagesRepo.insertMessage(doc)
      res.status(201).json({ ok: true, message: { _id: doc._id, seq: doc.seq } })
    }),
  )

  // Patch optional title/context and/or the builder code snapshot on an owned header.
  router.patch(
    '/:id',
    safe(async (req, res) => {
      const username = req.user.sub
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid conversation id.' } })
      const { title, context, code } = req.body || {}
      if (code !== undefined) {
        const codeErr = validateCodeSnapshot(code)
        if (codeErr) return res.status(400).json({ error: { message: codeErr } })
      }

      const existing = await conversationsRepo.getHeader(id, username)
      if (!existing) return res.status(404).json({ error: { message: 'Conversation not found.' } })

      if (code !== undefined) await conversationsRepo.patchCode(id, username, code)
      if (title !== undefined || context !== undefined) {
        await conversationsRepo.upsertHeader({
          _id: id,
          username,
          kind: existing.kind, // existing → $setOnInsert is a no-op; keeps kind stable
          title: typeof title === 'string' ? title : undefined,
          context,
        })
      }
      res.json({ ok: true })
    }),
  )

  // Delete a conversation the caller owns: sweep its attachment objects, then its
  // messages, then the header.
  router.delete(
    '/:id',
    safe(async (req, res) => {
      const username = req.user.sub
      const { id } = req.params
      if (!ID_RE.test(id)) return res.status(400).json({ error: { message: 'Invalid conversation id.' } })
      const header = await conversationsRepo.getHeader(id, username)
      if (!header) return res.status(404).json({ error: { message: 'Conversation not found.' } })

      const messages = await messagesRepo.listByConversation(id, username)
      const fileRefs = messages.flatMap((m) =>
        (m.parts || [])
          .filter((p) => p?.type === 'file')
          .map((p) => ({ attachmentId: p.attachmentId, size: p.size })),
      )
      await attachmentsRepo.deleteByConversation(fileRefs, username)
      await messagesRepo.deleteByConversation(id, username)
      await conversationsRepo.deleteHeader(id, username)
      res.json({ ok: true })
    }),
  )

  return router
}
