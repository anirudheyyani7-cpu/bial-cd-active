import { useState, useEffect, useRef } from 'react'
import { Monitor, Smartphone, Code2, LayoutTemplate, X } from 'lucide-react'

const VIEWPORTS = { Desktop: 'w-full', Mobile: 'max-w-[390px]' }
const VP_ICONS = { Desktop: Monitor, Mobile: Smartphone }

const STAGE_PROGRESS = [0, 15, 35, 65, 85, 100]
const STAGE_TEXT = [
  '',
  'Analyzing requirements...',
  'Creating wireframe...',
  'Generating code...',
  'Rendering preview...',
  'Ready',
]

export default function LivePreview({ previewCode, generating, generationStage, config, accessToken, user }) {
  const [viewport, setViewport] = useState('Desktop')
  const [showCode, setShowCode] = useState(false)
  const iframeRef = useRef(null)
  const previewCodeRef = useRef(previewCode)
  previewCodeRef.current = previewCode
  // Refs so the (mount-once) previewReady handler always reads the CURRENT data
  // wiring + token without re-subscribing on every config/token change.
  const configRef = useRef(config)
  configRef.current = config
  const tokenRef = useRef(accessToken)
  tokenRef.current = accessToken
  const userRef = useRef(user)
  userRef.current = user

  // The preview renders inside an isolated, same-origin /preview iframe that has
  // its OWN relaxed CSP (the main app's CSP stays strict). It runs as a sandboxed
  // OPAQUE-ORIGIN frame, so it cannot read the portal's localStorage — the data
  // wiring `config` ({ appId, appKey, baseUrl, loginRequired }) and the short-lived
  // `accessToken` (login apps only) are handed in via postMessage alongside the
  // generated code, exactly as the deployed runner does. The code is sent once
  // when the shell signals ready (first load + any remount) and on every refinement.
  useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.previewReady && iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          { previewCode: previewCodeRef.current, config: configRef.current, accessToken: tokenRef.current, user: userRef.current },
          '*',
        )
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    if (previewCode && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { previewCode, config: configRef.current, accessToken: tokenRef.current, user: userRef.current },
        '*',
      )
    }
  }, [previewCode])

  // Re-push the data wiring/token when they change on their own (e.g. provision
  // completes, or the token is (re)issued) without a code regeneration.
  useEffect(() => {
    if ((config || accessToken || user) && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ config, accessToken, user }, '*')
    }
  }, [config, accessToken, user])

  const progress = STAGE_PROGRESS[generationStage] ?? 0
  const stageText = STAGE_TEXT[generationStage] ?? ''

  const showEmpty = !generating && !previewCode
  const showLoading = generating && !previewCode
  const showPreview = !generating && !!previewCode

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-bial-border bg-white flex-shrink-0">
        <div className="flex items-center gap-1 bg-bial-bg rounded-lg p-1">
          {Object.entries(VP_ICONS).map(([label, Icon]) => (
            <button
              key={label}
              onClick={() => setViewport(label)}
              className={`flex items-center gap-1.5 text-xs font-worksans font-medium px-3 py-1.5 rounded-md transition ${
                viewport === label
                  ? 'bg-white text-primary shadow-sm border border-bial-border'
                  : 'text-neutral hover:text-primary'
              }`}
            >
              <Icon size={12} />{label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCode((s) => !s)}
            className={`flex items-center gap-1.5 text-xs font-worksans font-semibold border rounded-lg px-3 py-1.5 transition ${
              showCode
                ? 'bg-primary/5 border-primary text-primary'
                : 'text-neutral border-bial-border hover:border-primary hover:text-primary'
            }`}
          >
            <Code2 size={11} />View Code
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Preview canvas */}
        <div className="flex-1 bg-[#e8edf2] flex justify-center p-4 overflow-auto">
          {showEmpty && (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
                <LayoutTemplate size={28} className="text-gray-300" />
              </div>
              <p className="text-sm font-semibold text-neutral mb-1">Your app preview will appear here</p>
              <p className="text-xs text-neutral/60 max-w-xs leading-relaxed">
                Submit a prompt or refine your instructions to generate a live preview
              </p>
            </div>
          )}

          {showLoading && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <div className="flex gap-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-3 h-3 bg-primary rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.2}s` }}
                  />
                ))}
              </div>
              <p className="text-sm text-neutral font-medium">{stageText}</p>
              <div className="w-64 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {(showPreview || (generating && previewCode)) && (
            <div className={`${VIEWPORTS[viewport]} h-full transition-all duration-300 rounded-xl overflow-hidden shadow-lg bg-white relative`}>
              {generating && (
                <div className="absolute inset-0 bg-white/60 z-10 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3">
                    <svg className="animate-spin h-7 w-7 text-primary" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <p className="text-sm text-neutral font-medium">{stageText}</p>
                  </div>
                </div>
              )}
              {previewCode && (
                <iframe
                  ref={iframeRef}
                  src="/preview"
                  className="w-full h-full border-0"
                  title="App Preview"
                  /* allow-forms so the app's <form onSubmit> handlers fire (parity with
                     the deployed runner frame); native form navigation is blocked by the
                     /preview CSP's form-action 'none', so the injected token can't leak.
                     allow-downloads lets a generated app trigger a file download via an
                     <a download> SAS navigation (governed by this token, NOT connect-src,
                     so the blob host never enters the frame CSP). */
                  sandbox="allow-scripts allow-forms allow-downloads"
                />
              )}
            </div>
          )}
        </div>

        {/* Code slide-out panel */}
        {showCode && (
          <div className="w-96 bg-gray-900 flex flex-col border-l border-gray-700 flex-shrink-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Code2 size={13} className="text-gray-400" />
                <span className="text-xs font-semibold text-gray-200">Generated Code</span>
              </div>
              <button onClick={() => setShowCode(false)} className="text-gray-400 hover:text-gray-200 transition">
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-xs text-green-400 font-mono leading-relaxed whitespace-pre-wrap break-all">
                {previewCode || '// No code generated yet.\n// Submit a prompt to see the generated React code here.'}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Progress bar at bottom during generation */}
      {generating && (
        <div className="h-0.5 bg-gray-100 flex-shrink-0">
          <div
            className="h-full bg-primary transition-all duration-700 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  )
}
