import { useState, useEffect } from 'react'
import { FileText, ImageOff } from 'lucide-react'
import { getAttachment } from '../utils/attachmentStore'

/**
 * Render a single persisted attachment ref by reading its bytes back from the
 * IndexedDB store. Images become inline thumbnails; PDFs become a labelled chip;
 * a ref whose bytes are gone (cleared / different browser) shows an
 * "unavailable" placeholder instead of crashing.
 */
function AttachmentChip({ att }) {
  const isPdf = att.mediaType === 'application/pdf'
  const [src, setSrc] = useState(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (isPdf) return undefined
    let active = true
    getAttachment(att.id).then((b64) => {
      if (!active) return
      if (b64) setSrc(`data:${att.mediaType};base64,${b64}`)
      else setMissing(true)
    })
    return () => {
      active = false
    }
  }, [att.id, att.mediaType, isPdf])

  if (isPdf) {
    return (
      <span className="inline-flex items-center gap-1.5 bg-white/10 border border-white/20 rounded-lg px-2 py-1 text-[11px] max-w-[12rem]">
        <FileText size={12} className="flex-shrink-0" />
        <span className="truncate">{att.name}</span>
      </span>
    )
  }

  if (missing) {
    return (
      <span className="inline-flex items-center gap-1.5 bg-white/10 border border-white/20 rounded-lg px-2 py-1 text-[11px] opacity-70">
        <ImageOff size={12} className="flex-shrink-0" />
        attachment unavailable
      </span>
    )
  }

  return (
    <img
      src={src || undefined}
      alt={att.name}
      title={att.name}
      className="h-16 w-16 object-cover rounded-lg border border-white/20 bg-white/10"
    />
  )
}

export default function AttachmentChips({ attachments }) {
  if (!attachments?.length) return null
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {attachments.map((att) => (
        <AttachmentChip key={att.id} att={att} />
      ))}
    </div>
  )
}
