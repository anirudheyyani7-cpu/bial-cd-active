import { useState, useEffect } from 'react'
import { Monitor, Tablet, Smartphone, Rocket, RefreshCw } from 'lucide-react'

function extractPreviewCode(text) {
  const match = text.match(/```jsx:preview\s*([\s\S]*?)```/)
  return match ? match[1].trim() : null
}

const DEFAULT_HTML = `
<div style="padding:24px;font-family:'Manrope',sans-serif;background:#F0F4F8;min-height:100%">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
    <div>
      <h1 style="font-size:20px;font-weight:800;color:#1A2B34;margin:0 0 4px">Terminal 3 Baggage Tracking</h1>
      <p style="font-size:12px;color:#64748B;margin:0">Real-time telemetry — belts 12A through 24C</p>
    </div>
    <div style="text-align:right">
      <p style="font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:0.05em;margin:0">Active Carousels</p>
      <p style="font-size:28px;font-weight:800;color:#1A2B34;margin:0">18 <span style="font-size:14px;font-weight:400;color:#64748B">/ 20</span></p>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 200px;gap:16px;margin-bottom:16px">
    <div style="background:white;border-radius:16px;padding:16px;border:1px solid #E2E8F0">
      <p style="font-size:12px;font-weight:700;color:#1A2B34;margin:0 0 12px">System Throughput (Bags/Hour)</p>
      <div style="display:flex;align-items:flex-end;gap:6px;height:80px">
        ${[65,72,58,80,92,78,85,95,88,76].map((h,i) =>
          `<div style="flex:1;border-radius:4px 4px 0 0;height:${h}%;background:${i===7?'#D9A036':'#00818A20'}"></div>`
        ).join('')}
      </div>
    </div>
    <div style="background:#1A2B34;border-radius:16px;padding:16px;color:white;display:flex;flex-direction:column;justify-content:space-between">
      <p style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;opacity:0.6;margin:0 0 12px">Quick Summary</p>
      <div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px"><span style="opacity:0.7">Critical Alerts</span><span style="font-weight:700;color:#4ade80">0</span></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px"><span style="opacity:0.7">Processing Lag</span><span style="font-weight:700">1.2s</span></div>
        <div style="display:flex;justify-content:space-between;font-size:12px"><span style="opacity:0.7">Avg Sort Time</span><span style="font-weight:700">4.5m</span></div>
      </div>
      <button style="margin-top:12px;width:100%;background:rgba(255,255,255,0.1);border:none;color:white;font-size:11px;font-weight:600;padding:8px;border-radius:8px;cursor:pointer">Download Logs</button>
    </div>
  </div>
  <div style="background:white;border-radius:16px;border:1px solid #E2E8F0;overflow:hidden">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #E2E8F0">
      <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#1A2B34;margin:0">Active Belt Units</p>
      <span style="font-size:9px;background:#00818A1A;color:#00818A;font-weight:700;padding:2px 8px;border-radius:20px">AUTO-REFRESH 1s</span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#F8FAFC;color:#64748B;font-size:10px;text-transform:uppercase;letter-spacing:0.05em">
        <th style="text-align:left;padding:8px 16px">Unit ID</th>
        <th style="text-align:left;padding:8px 16px">Load %</th>
        <th style="text-align:left;padding:8px 16px">Motor Temp</th>
        <th style="text-align:left;padding:8px 16px">Status</th>
      </tr></thead>
      <tbody>
        <tr style="border-top:1px solid #E2E8F0"><td style="padding:12px 16px;font-weight:600">BELT-12A</td><td style="padding:12px 16px"><div style="width:80px;height:4px;background:#f1f5f9;border-radius:2px"><div style="width:45%;height:4px;background:#00818A;border-radius:2px"></div></div></td><td style="padding:12px 16px">42°C</td><td style="padding:12px 16px;color:#22c55e;font-weight:600">● Optimal</td></tr>
        <tr style="border-top:1px solid #E2E8F0"><td style="padding:12px 16px;font-weight:600">BELT-14B</td><td style="padding:12px 16px"><div style="width:80px;height:4px;background:#f1f5f9;border-radius:2px"><div style="width:72%;height:4px;background:#D9A036;border-radius:2px"></div></div></td><td style="padding:12px 16px">58°C</td><td style="padding:12px 16px;color:#D9A036;font-weight:600">● High Load</td></tr>
      </tbody>
    </table>
  </div>
</div>`

function buildIframeDoc(jsxCode) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
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

const VIEWPORTS = { Desktop: 'w-full', Tablet: 'max-w-[768px]', Mobile: 'max-w-[390px]' }
const VP_ICONS = { Desktop: Monitor, Tablet: Tablet, Mobile: Smartphone }

export default function LivePreview({ messages, generating }) {
  const [viewport, setViewport] = useState('Desktop')
  const [iframeSrc, setIframeSrc] = useState(`data:text/html,${encodeURIComponent(`<!DOCTYPE html><html><head><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;800&display=swap" rel="stylesheet"/><style>body{margin:0;font-family:'Manrope',sans-serif;}</style></head><body>${DEFAULT_HTML}</body></html>`)}`)

  useEffect(() => {
    const assistantMsgs = [...messages].reverse().filter((m) => m.role === 'assistant')
    for (const msg of assistantMsgs) {
      const code = extractPreviewCode(msg.content)
      if (code) {
        setIframeSrc(`data:text/html,${encodeURIComponent(buildIframeDoc(code))}`)
        return
      }
    }
  }, [messages])

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
                viewport === label ? 'bg-white text-primary shadow-sm border border-bial-border' : 'text-neutral hover:text-primary'
              }`}
            >
              <Icon size={12} />{label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 text-xs font-worksans font-semibold text-neutral border border-bial-border rounded-lg px-3 py-1.5 hover:border-primary hover:text-primary transition">
            <RefreshCw size={11} />Logic View
          </button>
          <button className="flex items-center gap-1.5 text-xs font-worksans font-bold text-white bg-primary hover:bg-primary-600 rounded-lg px-3 py-1.5 transition">
            <Rocket size={11} />Deploy App
          </button>
        </div>
      </div>

      {/* Preview */}
      <div className="flex-1 bg-[#e8edf2] flex justify-center p-4 overflow-auto relative">
        {generating && (
          <div className="absolute inset-0 bg-white/60 z-10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <svg className="animate-spin h-7 w-7 text-primary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              <p className="text-sm text-neutral font-medium">Stitch AI is generating…</p>
            </div>
          </div>
        )}
        <div className={`${VIEWPORTS[viewport]} h-full transition-all duration-300 rounded-xl overflow-hidden shadow-lg bg-white`}>
          <iframe src={iframeSrc} className="w-full h-full border-0" title="App Preview" sandbox="allow-scripts" />
        </div>
      </div>
    </div>
  )
}
