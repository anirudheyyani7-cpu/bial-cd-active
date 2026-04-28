import { useState, useEffect } from 'react'
import { Monitor, Smartphone, Rocket, RefreshCw, Code2, LayoutTemplate, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

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

function buildIframeDoc(jsxCode) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://unpkg.com/lucide-react/dist/umd/lucide-react.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{primary:'#00818A',secondary:'#D9A036',tertiary:'#1A2B34'},fontFamily:{manrope:['Manrope','sans-serif']}}}}</script>
<style>body{margin:0;font-family:'Manrope',sans-serif;}</style>
</head><body>
<div id="root"></div>
<script type="text/babel">
${jsxCode}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(PreviewApp));
</script>
</body></html>`
}

export default function LivePreview({ previewCode, generating, generationStage, prompt }) {
  const navigate = useNavigate()
  const [viewport, setViewport] = useState('Desktop')
  const [showCode, setShowCode] = useState(false)
  const [iframeSrc, setIframeSrc] = useState(null)

  useEffect(() => {
    if (previewCode) {
      setIframeSrc(`data:text/html,${encodeURIComponent(buildIframeDoc(previewCode))}`)
    }
  }, [previewCode])

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
          <button className="flex items-center gap-1.5 text-xs font-worksans font-semibold text-neutral border border-bial-border rounded-lg px-3 py-1.5 hover:border-primary hover:text-primary transition">
            <RefreshCw size={11} />Logic View
          </button>
          <button
            onClick={() => navigate('/workspace/deploy', { state: { appDesc: prompt || '' } })}
            className="flex items-center gap-1.5 text-xs font-worksans font-bold text-white bg-primary hover:bg-primary-600 rounded-lg px-3 py-1.5 transition"
          >
            <Rocket size={11} />Deploy App
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
              {iframeSrc && (
                <iframe
                  src={iframeSrc}
                  className="w-full h-full border-0"
                  title="App Preview"
                  sandbox="allow-scripts"
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
