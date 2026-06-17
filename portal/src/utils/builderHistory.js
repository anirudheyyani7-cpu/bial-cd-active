/**
 * Per-user builder-session store (browser-only, interim). Mirrors chatHistory.js
 * exactly — namespaced key, defensive try/catch, named exports — so builder
 * sessions, which today vanish on refresh, get the same per-user persistence and
 * survive a token-expiry (clearSession no longer wipes anything).
 *
 * A build record is `{ id, title, createdAt, updatedAt, context, messages }`:
 *   - context: the generation settings (dataSource/theme/hasSchema/uploadedFiles)
 *     so refinements after a resume keep their configuration.
 *   - messages: REAL turns only (user + assistant result). Ephemeral stage /
 *     welcome bubbles are excluded by the caller before persisting.
 */
import { getStoredUser } from './auth.js'
import { deleteAttachment } from './attachmentStore.js'

const STORAGE_KEY_PREFIX = 'bial_builder_history'

function storageKey() {
  const username = getStoredUser()?.username || '__anon__'
  return `${STORAGE_KEY_PREFIX}:${username}`
}

export function loadBuilds() {
  try {
    const raw = localStorage.getItem(storageKey())
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveBuilds(builds) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(builds))
  } catch {
    // storage full / unavailable — best-effort for the interim build
  }
}

export function newBuild(prompt, context) {
  // Random suffix so builds created in the same millisecond don't collide.
  const id = `build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const trimmed = (prompt || '').trim()
  const title = (trimmed.slice(0, 40) || 'Untitled build') + (trimmed.length > 40 ? '…' : '')
  const now = new Date().toISOString()
  const build = { id, title, createdAt: now, updatedAt: now, context: context || null, messages: [] }
  saveBuilds([build, ...loadBuilds()])
  return id
}

export function appendBuilderMessage(buildId, message) {
  const builds = loadBuilds()
  const updated = builds.map((b) =>
    b.id === buildId ? { ...b, updatedAt: new Date().toISOString(), messages: [...b.messages, message] } : b,
  )
  saveBuilds(updated)
}

export function getBuild(buildId) {
  return loadBuilds().find((b) => b.id === buildId) || null
}

export function deleteBuild(buildId) {
  const build = getBuild(buildId)
  // Free this build's attachment bytes (see chatHistory.deleteConversation) so
  // the shared per-user IndexedDB cap isn't a one-way ratchet. Best-effort.
  build?.messages.forEach((m) => m.attachments?.forEach((a) => deleteAttachment(a.id)))
  saveBuilds(loadBuilds().filter((b) => b.id !== buildId))
}
