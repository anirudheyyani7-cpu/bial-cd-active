import { useState, useEffect } from 'react'
import { FileText, FileSpreadsheet, ImageOff } from 'lucide-react'
import { fetchAttachmentObjectUrl } from '../utils/attachmentApi'
import { openUrlInNewTab } from '../utils/attachmentViewer'
import AttachmentLightbox from './AttachmentLightbox'

/**
 * Render one persisted attachment descriptor `{ attachmentId, kind, name,
 * mediaType }` (derived from a message's parts). Images fetch their bytes from
 * the server object store as an object URL and show an inline thumbnail that
 * opens a lightbox; PDFs open in a new tab on click; text/CSV show a labelled
 * file-icon chip (no byte read — the content travelled inline in the prompt); an
 * image whose bytes are gone/forbidden shows an "unavailable" placeholder.
 */
function AttachmentChip({ att }) {
  const isText = att.kind === 'text'
  const isPdf = att.kind === 'document' || att.mediaType === 'application/pdf'
  const [src, setSrc] = useState(null)
  const [missing, setMissing] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    // Only images preview from bytes.
    if (isPdf || isText) return undefined
    let active = true
    fetchAttachmentObjectUrl(att.attachmentId).then((url) => {
      if (!active) return
      if (url) setSrc(url)
      else setMissing(true)
    })
    return () => {
      active = false
    }
  }, [att.attachmentId, isPdf, isText])

  if (isText) {
    const Icon = att.mediaType === 'text/csv' ? FileSpreadsheet : FileText
    return (
      <span
        title={att.name}
        className="inline-flex items-center gap-1.5 bg-white/10 border border-white/20 rounded-lg px-2 py-1 text-[11px] max-w-[12rem]"
      >
        <Icon size={12} className="flex-shrink-0" />
        <span className="truncate">{att.name}</span>
      </span>
    )
  }

  if (isPdf) {
    return (
      <button
        type="button"
        onClick={async () => {
          const url = await fetchAttachmentObjectUrl(att.attachmentId)
          if (url) openUrlInNewTab(url, att.name)
        }}
        title={`Open ${att.name}`}
        className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg px-2 py-1 text-[11px] max-w-[12rem] cursor-pointer transition"
      >
        <FileText size={12} className="flex-shrink-0" />
        <span className="truncate">{att.name}</span>
      </button>
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
    <>
      <img
        src={src || undefined}
        alt={att.name}
        title={`View ${att.name}`}
        onClick={() => src && setZoomed(true)}
        className="h-16 w-16 object-cover rounded-lg border border-white/20 bg-white/10 cursor-zoom-in hover:opacity-90 transition"
      />
      {zoomed && <AttachmentLightbox name={att.name} src={src} onClose={() => setZoomed(false)} />}
    </>
  )
}

export default function AttachmentChips({ attachments }) {
  if (!attachments?.length) return null
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {attachments.map((att) => (
        <AttachmentChip key={att.attachmentId} att={att} />
      ))}
    </div>
  )
}
