import { useState, useRef, useCallback, useEffect } from 'react'
import { validateAttachmentFiles, fileToBase64, newAttachmentId } from '../utils/attachmentInput'

/**
 * Shared composer state for image/PDF attachments (used by ChatPage and
 * BuilderPage). Owns the pending-attachment list (each item carries transient
 * base64 until the message is sent) and a short-lived validation/cap toast.
 * Each page renders the toast + preview row in its own style; the behaviour
 * lives here so the two composers can't drift.
 */
export function usePendingAttachments() {
  const [pendingAttachments, setPendingAttachments] = useState([])
  const [attachToast, setAttachToast] = useState(null)
  const toastTimer = useRef(null)

  useEffect(() => () => toastTimer.current && clearTimeout(toastTimer.current), [])

  const showAttachToast = useCallback((msg) => {
    setAttachToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setAttachToast(null), 3500)
  }, [])

  const handleFileSelect = useCallback(
    async (e) => {
      const incoming = Array.from(e.target.files || [])
      e.target.value = '' // allow re-selecting the same file later
      if (incoming.length === 0) return
      const result = validateAttachmentFiles(incoming, pendingAttachments.length)
      if (result.error) {
        showAttachToast(result.error)
        return
      }
      try {
        const read = await Promise.all(
          incoming.map(async (file) => ({
            id: newAttachmentId(),
            name: file.name,
            mediaType: file.type,
            size: file.size,
            base64: await fileToBase64(file),
          })),
        )
        setPendingAttachments((prev) => [...prev, ...read])
      } catch {
        showAttachToast('Could not read the selected file.')
      }
    },
    [pendingAttachments.length, showAttachToast],
  )

  const removePending = useCallback((id) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const clearPending = useCallback(() => setPendingAttachments([]), [])

  return { pendingAttachments, handleFileSelect, removePending, clearPending, attachToast, showAttachToast }
}
