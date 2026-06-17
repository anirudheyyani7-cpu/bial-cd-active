/**
 * Pure helpers for the chat attachment composer (shared by ChatPage and
 * BuilderPage). Validation + base64 reading + ref-building live here so the
 * composer logic is testable without a DOM render. The real trust boundary is
 * the server (media-type allowlist + magic-byte check); these checks are UX.
 */

// Native Anthropic content types only. Word/CSV/XLSX are NOT native documents.
export const ALLOWED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']
export const ACCEPT_ATTR = ALLOWED_MEDIA_TYPES.join(',')

export const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4 MB on the original File.size
export const MAX_FILES_PER_MESSAGE = 5

export const WORD_REJECT_MSG = "Word docs aren't supported — please save as PDF and re-upload."

function isWordFile(file) {
  return (
    /\.docx?$/i.test(file.name || '') ||
    file.type === 'application/msword' ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
}

/**
 * Validate a batch of newly selected files against the per-message rules.
 * Returns `{ error }` with a user-facing message on the first violation, or
 * `{ ok: true }` when all pass. Caps are measured on the original File.size.
 */
export function validateAttachmentFiles(incoming, currentCount = 0) {
  if (currentCount + incoming.length > MAX_FILES_PER_MESSAGE) {
    return { error: `You can attach at most ${MAX_FILES_PER_MESSAGE} files per message.` }
  }
  for (const file of incoming) {
    if (isWordFile(file)) return { error: WORD_REJECT_MSG }
    if (!ALLOWED_MEDIA_TYPES.includes(file.type)) {
      return { error: `"${file.name}" isn't supported. Attach an image (PNG, JPEG, GIF, WebP) or a PDF.` }
    }
    if (file.size > MAX_FILE_SIZE) {
      return { error: `"${file.name}" exceeds the 4 MB limit.` }
    }
  }
  return { ok: true }
}

/** Read a File as raw base64 (stripping the `data:<type>;base64,` prefix). */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** A unique attachment id (namespacing of bytes is by id within the store). */
export function newAttachmentId() {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** Strip transient base64 to the lightweight ref persisted in the conversation. */
export function toAttachmentRef({ id, name, mediaType, size }) {
  return { id, name, mediaType, size }
}
