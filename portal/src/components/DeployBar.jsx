import { useState } from 'react'
import { Rocket, Loader2, CheckCircle, Clock, XCircle, Copy, ExternalLink, RefreshCw } from 'lucide-react'

const STATUS_META = {
  pending: { label: 'Pending admin review', cls: 'text-amber-700 bg-amber-100', Icon: Clock },
  approved: { label: 'Approved & live', cls: 'text-green-700 bg-green-100', Icon: CheckCircle },
  rejected: { label: 'Changes requested', cls: 'text-red-700 bg-red-100', Icon: XCircle },
  disabled: { label: 'Disabled by admin', cls: 'text-gray-600 bg-gray-200', Icon: XCircle },
}

/**
 * Deploy bar above the preview — "Submit for deployment" + the live deploy status,
 * and (once approved) the shareable /apps/:appId URL with copy. Pure/props-driven
 * so the BuilderPage owns the API calls (provision/submit/status). A submit error
 * is surfaced by the caller's toast — never silently dropped.
 */
export default function DeployBar({ status, appId, rejectionNote, busy, onSubmit, onRefresh }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/apps/${appId}`
  const meta = STATUS_META[status]

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  // Submit is the primary CTA when not yet submitted (no status / draft). For
  // pending/approved/rejected, allow a re-submit of the current code ("update").
  const submitLabel = !status || status === 'draft' ? 'Submit for deployment' : 'Submit update'

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-bial-border bg-white flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {meta ? (
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${meta.cls}`}>
            <meta.Icon size={12} /> {meta.label}
          </span>
        ) : (
          <span className="text-xs text-neutral">Not deployed</span>
        )}
        {status === 'approved' && appId && (
          <div className="flex items-center gap-1.5 min-w-0">
            <code data-testid="deploy-url" className="text-[11px] text-tertiary bg-bial-bg rounded px-1.5 py-0.5 truncate max-w-[16rem]">
              /apps/{appId}
            </code>
            <button onClick={copy} title="Copy app URL" className="p-1 text-neutral hover:text-primary transition">
              <Copy size={12} />
            </button>
            {copied && <span className="text-[10px] text-green-600">Copied</span>}
            <a href={url} target="_blank" rel="noreferrer" title="Open app" className="p-1 text-neutral hover:text-primary transition">
              <ExternalLink size={12} />
            </a>
          </div>
        )}
        {status === 'rejected' && rejectionNote && (
          <span data-testid="reject-note" className="text-[11px] text-red-600 truncate max-w-[20rem]" title={rejectionNote}>
            “{rejectionNote}”
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {onRefresh && status && (
          <button onClick={onRefresh} disabled={busy} title="Refresh status" className="p-1.5 text-neutral hover:text-primary disabled:opacity-40 transition">
            <RefreshCw size={13} />
          </button>
        )}
        <button
          data-testid="submit-deploy"
          onClick={onSubmit}
          disabled={busy}
          className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Rocket size={12} />}
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
