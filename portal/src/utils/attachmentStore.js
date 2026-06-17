/**
 * Per-user attachment byte store (IndexedDB) + content-block helpers.
 *
 * The single owner of attachment *bytes* in the interim build: the conversation
 * (localStorage) keeps only lightweight refs `{id, name, mediaType, size}`, the
 * base64 bytes live here keyed by `id`. Mirrors the isolation idiom of
 * chatHistory.js / auth.js — one module, named exports, defensive try/catch.
 *
 * Namespacing is per user (resolved from getStoredUser): every record carries a
 * `user` field and each user has a tiny `__meta__:<user>` record holding an O(1)
 * running byte total, so the cap check on put never scans the store. (Bytes
 * still physically remain in this browser across users — accepted residual;
 * real isolation arrives with the FastAPI backend.)
 *
 * The buildContentBlocks / contentToText helpers live here because this is the
 * only module that knows how bytes map onto Anthropic content blocks.
 */
import { getStoredUser } from './auth.js'

const DB_NAME = 'bial_attachments'
const STORE = 'attachments'
const DB_VERSION = 1
// ~50 MB per-user running total, to stop the browser store from bloating.
const TOTAL_CAP = 50 * 1024 * 1024

/** Thrown when a put would exceed the per-user total cap; the UI catches it. */
export class AttachmentCapError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AttachmentCapError'
    this.code = 'ATTACHMENT_STORE_FULL'
  }
}

function currentUser() {
  return getStoredUser()?.username || '__anon__'
}

const metaId = (user) => `__meta__:${user}`

let dbPromise = null
function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      reject(err)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((err) => {
    // Don't cache a rejected open: a transient failure (private mode, quota,
    // storage disabled) would otherwise make every later call fail for the tab's
    // lifetime. Reset so the next call retries a fresh open.
    dbPromise = null
    throw err
  })
  return dbPromise
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// One transaction per op (not a shared multi-request tx): an `await` between
// requests in the same IndexedDB transaction can hit the real-browser
// "transaction inactive" race. Atomicity isn't needed for an interim store.
function get(db, key) {
  return reqToPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))
}
function put(db, value) {
  return reqToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value))
}
function del(db, key) {
  return reqToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key))
}

/**
 * Store base64 bytes for an attachment. Enforces the per-user total cap up front
 * (rejecting with AttachmentCapError, store left unchanged). Errors propagate —
 * unlike the reads below — so the cap error and any storage failure surface to
 * the UI rather than silently dropping the bytes.
 */
export async function putAttachment({ id, base64, mediaType, size }) {
  const user = currentUser()
  const db = await openDB()
  // Adjust the running total by the DELTA vs any existing record for this id, so
  // re-putting the same id (overwrite, no new storage) doesn't double-count and
  // inflate the total toward false-positive cap rejections.
  const existing = await get(db, id)
  const delta = size - (existing?.size || 0)
  const meta = (await get(db, metaId(user))) || { id: metaId(user), user, total: 0 }
  if (meta.total + delta > TOTAL_CAP) {
    throw new AttachmentCapError('Attachment storage is full. Remove some attachments and try again.')
  }
  await put(db, { id, user, base64, mediaType, size })
  meta.total += delta
  await put(db, meta)
}

/** base64 bytes for `id`, or null (unknown id / IndexedDB unavailable). */
export async function getAttachment(id) {
  try {
    const db = await openDB()
    const rec = await get(db, id)
    return rec?.base64 ?? null
  } catch {
    return null
  }
}

/** Remove an attachment and decrement its owner's running total. Best-effort. */
export async function deleteAttachment(id) {
  try {
    const db = await openDB()
    const rec = await get(db, id)
    if (!rec) return
    await del(db, id)
    const meta = await get(db, metaId(rec.user))
    if (meta) {
      meta.total = Math.max(0, meta.total - (rec.size || 0))
      await put(db, meta)
    }
  } catch {
    // best-effort; a dangling total is harmless and self-heals on clear.
  }
}

/** O(1) read of a user's running byte total (no store scan). 0 on miss/error. */
export async function getTotalSize(user = currentUser()) {
  try {
    const db = await openDB()
    const meta = await get(db, metaId(user))
    return meta?.total || 0
  } catch {
    return 0
  }
}

/** Delete all of one user's records (incl. their meta total). Best-effort. */
export async function clearForUser(user = currentUser()) {
  try {
    const db = await openDB()
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    await new Promise((resolve, reject) => {
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return resolve()
        if (cursor.value?.user === user) cursor.delete()
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    // best-effort
  }
}

/**
 * Assemble a message's `content` for the API. With no attachments returns the
 * plain string (the unchanged path). With attachments returns a ContentBlock[]
 * with the file blocks BEFORE the text block (Anthropic ordering). A ref whose
 * bytes are missing is skipped rather than sent as a null-data block.
 */
export async function buildContentBlocks(text, attachments, getBytes = getAttachment) {
  if (!attachments || attachments.length === 0) return text
  const blocks = []
  for (const a of attachments) {
    const data = await getBytes(a.id)
    if (!data) continue
    if (a.mediaType === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })
    } else {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data } })
    }
  }
  blocks.push({ type: 'text', text })
  return blocks
}

/** Total attachment refs across a conversation's messages (count, not bytes). */
export function countAttachments(messages) {
  if (!Array.isArray(messages)) return 0
  return messages.reduce((n, m) => n + (m?.attachments?.length || 0), 0)
}

/** Extract human-readable text from string OR ContentBlock[] content. */
export function contentToText(content) {
  if (typeof content === 'string') return content
  return (content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/**
 * Map a conversation's messages to the API `{ role, content }` shape, turning a
 * turn that carries attachment refs into a ContentBlock[] (bytes re-read from
 * the store, files before text) and leaving plain turns as strings. Shared by
 * both chat surfaces so the assembly can't drift between them.
 */
export async function assembleApiMessages(messages, getBytes = getAttachment) {
  // Only the NEWEST turn's attachment bytes are inflated into the request body.
  // Re-base64-ing every historical attachment on every send grows the body
  // unbounded across turns and eventually blows past the 35MB route / 32MB API
  // ceiling (the per-message caps don't bound the per-conversation total). Older
  // attachment turns send their text only — the model already saw those files in
  // the turn they were sent.
  const lastIdx = messages.length - 1
  return Promise.all(
    messages.map(async (m, i) => ({
      role: m.role,
      content: i === lastIdx && m.attachments?.length
        ? await buildContentBlocks(contentToText(m.content), m.attachments, getBytes)
        : contentToText(m.content),
    })),
  )
}
