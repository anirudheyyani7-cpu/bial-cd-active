import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { CheckCircle, X, ChevronDown, ExternalLink } from 'lucide-react'
import Navbar from '../components/layout/Navbar'

const CATEGORIES = ['Operations', 'Logistics', 'Security', 'Customer Service', 'Maintenance', 'Analytics']

const ICON_COLORS = [
  { id: 'teal', bg: 'bg-primary', label: 'Teal' },
  { id: 'amber', bg: 'bg-secondary', label: 'Amber' },
  { id: 'green', bg: 'bg-green-500', label: 'Green' },
  { id: 'blue', bg: 'bg-blue-500', label: 'Blue' },
  { id: 'red', bg: 'bg-red-500', label: 'Red' },
  { id: 'purple', bg: 'bg-purple-500', label: 'Purple' },
  { id: 'gray', bg: 'bg-gray-400', label: 'Gray' },
  { id: 'dark', bg: 'bg-tertiary', label: 'Dark' },
]

function Toggle({ label, description, value, onChange }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-semibold text-tertiary">{label}</p>
        <p className="text-xs text-neutral mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`w-10 h-5 rounded-full relative transition-colors duration-200 flex-shrink-0 ml-4 ${value ? 'bg-primary' : 'bg-gray-200'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

function SuccessModal({ appName, onClose }) {
  const navigate = useNavigate()
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl p-8 max-w-md w-full text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4 animate-bounce">
          <CheckCircle size={32} className="text-green-500" />
        </div>
        <h2 className="text-xl font-extrabold text-tertiary mb-2">Deployment Successful!</h2>
        <p className="text-sm text-neutral mb-4 leading-relaxed">
          Your app is now live. Access it from your workspace or share the link with your team.
        </p>
        <div className="bg-bial-bg border border-bial-border rounded-lg px-4 py-3 mb-6 flex items-center gap-2">
          <ExternalLink size={13} className="text-primary flex-shrink-0" />
          <span className="text-xs text-primary font-mono truncate">
            https://bial-apps.internal/app/{appName.toLowerCase().replace(/\s+/g, '-')}
          </span>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/workspace')}
            className="flex-1 px-4 py-2.5 border border-bial-border rounded-xl text-sm font-semibold text-neutral hover:border-primary hover:text-primary transition"
          >
            Go to My Workspace
          </button>
          <button
            onClick={() => navigate('/workspace')}
            className="flex-1 px-4 py-2.5 bg-primary text-white rounded-xl text-sm font-bold hover:bg-primary-dark transition"
          >
            View Deployed App
          </button>
        </div>
      </div>
    </div>
  )
}

export default function DeployPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const fromBuilder = location.state || {}

  const [appName, setAppName] = useState(fromBuilder.appName || '')
  const [appDesc, setAppDesc] = useState(fromBuilder.appDesc || '')
  const [selectedColor, setSelectedColor] = useState('teal')
  const [category, setCategory] = useState('Operations')
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [target, setTarget] = useState('workspace')
  const [authRequired, setAuthRequired] = useState(true)
  const [allowExport, setAllowExport] = useState(false)
  const [analytics, setAnalytics] = useState(true)
  const [showSuccess, setShowSuccess] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)

  const handleDeploy = () => setShowSuccess(true)

  const handleSaveDraft = () => {
    setSavingDraft(true)
    setTimeout(() => {
      setSavingDraft(false)
      navigate('/workspace')
    }, 1200)
  }

  const targetLabel = {
    workspace: 'My Workspace only',
    team: 'My Team Space',
    enterprise: 'Request Enterprise Publishing',
  }[target]

  return (
    <div className="min-h-screen bg-bial-bg font-manrope flex flex-col">
      <Navbar />

      <main className="flex-1 px-6 py-10">
        <div className="max-w-2xl mx-auto">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-extrabold text-tertiary mb-2">Deploy Your App</h1>
            <p className="text-neutral leading-relaxed">
              Configure deployment settings and push your app to the terminal operations dashboard.
            </p>
          </div>

          <div className="space-y-5">
            {/* Step 1: App Details */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-6 h-6 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center flex-shrink-0">1</div>
                <h2 className="text-sm font-bold text-tertiary">App Details</h2>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-neutral mb-1.5">App Name</label>
                  <input
                    type="text"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                    className="w-full border border-bial-border rounded-xl px-4 py-2.5 text-sm text-tertiary focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-neutral mb-1.5">App Description</label>
                  <textarea
                    value={appDesc}
                    onChange={(e) => setAppDesc(e.target.value)}
                    rows={3}
                    className="w-full border border-bial-border rounded-xl px-4 py-2.5 text-sm text-tertiary focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition resize-none"
                  />
                </div>

                <div className="flex gap-6 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <label className="block text-xs font-semibold text-neutral mb-2">App Icon Color</label>
                    <div className="flex flex-wrap gap-2">
                      {ICON_COLORS.map(({ id, bg, label }) => (
                        <button
                          key={id}
                          title={label}
                          onClick={() => setSelectedColor(id)}
                          className={`w-7 h-7 rounded-full ${bg} transition ring-offset-2 ${selectedColor === id ? 'ring-2 ring-primary' : 'hover:ring-2 hover:ring-gray-300'}`}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex-1 min-w-[140px]">
                    <label className="block text-xs font-semibold text-neutral mb-2">Category</label>
                    <div className="relative">
                      <button
                        onClick={() => setCategoryOpen((o) => !o)}
                        className="w-full flex items-center justify-between border border-bial-border rounded-xl px-4 py-2.5 text-sm text-tertiary hover:border-primary transition focus:outline-none"
                      >
                        {category}
                        <ChevronDown size={13} className={`transition-transform ${categoryOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {categoryOpen && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-bial-border rounded-xl shadow-lg z-10 py-1 overflow-hidden">
                          {CATEGORIES.map((c) => (
                            <button
                              key={c}
                              onClick={() => { setCategory(c); setCategoryOpen(false) }}
                              className={`w-full text-left px-4 py-2 text-sm hover:bg-bial-bg transition ${category === c ? 'text-primary font-semibold' : 'text-tertiary'}`}
                            >
                              {c}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 2: Deployment Target */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-6 h-6 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center flex-shrink-0">2</div>
                <h2 className="text-sm font-bold text-tertiary">Deployment Target</h2>
              </div>

              <div className="space-y-3">
                {[
                  { id: 'workspace', label: 'My Workspace only', desc: 'Keep as a private draft in your workspace' },
                  { id: 'team', label: 'My Team Space', desc: 'Share with your department team for collaborative use' },
                  { id: 'enterprise', label: 'Request Enterprise Publishing', desc: 'Submit for IT review and terminal-wide deployment' },
                ].map(({ id, label, desc }) => (
                  <label
                    key={id}
                    className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition ${target === id ? 'border-primary bg-primary/5' : 'border-bial-border hover:border-primary/50'}`}
                  >
                    <input
                      type="radio"
                      name="target"
                      value={id}
                      checked={target === id}
                      onChange={() => setTarget(id)}
                      className="mt-0.5 accent-primary flex-shrink-0"
                    />
                    <div>
                      <p className="text-sm font-semibold text-tertiary">{label}</p>
                      <p className="text-xs text-neutral mt-0.5">{desc}</p>
                      {id === 'enterprise' && target === 'enterprise' && (
                        <p className="text-xs text-secondary mt-1.5 font-medium">
                          Requires IT approval. Typical review time: 2-3 business days.
                        </p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Step 3: Access & Permissions */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center flex-shrink-0">3</div>
                <h2 className="text-sm font-bold text-tertiary">Access & Permissions</h2>
              </div>
              <div className="divide-y divide-bial-border">
                <Toggle
                  label="Require staff authentication"
                  description="Staff must log in with their BIAL credentials to access this app"
                  value={authRequired}
                  onChange={setAuthRequired}
                />
                <Toggle
                  label="Allow data export"
                  description="Users can export data as CSV or PDF from within the app"
                  value={allowExport}
                  onChange={setAllowExport}
                />
                <Toggle
                  label="Enable usage analytics"
                  description="Collect anonymised usage data to improve the app experience"
                  value={analytics}
                  onChange={setAnalytics}
                />
              </div>
            </div>

            {/* Step 4: Review Summary */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-6 h-6 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center flex-shrink-0">4</div>
                <h2 className="text-sm font-bold text-tertiary">Review Summary</h2>
              </div>

              <div className="flex gap-5 flex-wrap">
                <div className="flex-1 min-w-0 space-y-3">
                  {[
                    { label: 'App Name', value: appName },
                    { label: 'Category', value: category },
                    { label: 'Target', value: targetLabel },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between items-start gap-4">
                      <span className="text-xs text-neutral flex-shrink-0">{label}</span>
                      <span className="text-xs font-semibold text-tertiary text-right">{value}</span>
                    </div>
                  ))}
                  <div className="pt-2 border-t border-bial-border space-y-1.5">
                    <p className="text-xs text-neutral mb-1">Permissions</p>
                    {[
                      { label: 'Staff authentication', on: authRequired },
                      { label: 'Data export', on: allowExport },
                      { label: 'Usage analytics', on: analytics },
                    ].map(({ label, on }) => (
                      <div key={label} className="flex items-center gap-2">
                        <div className={`w-3.5 h-3.5 rounded-full flex items-center justify-center flex-shrink-0 ${on ? 'bg-green-100' : 'bg-gray-100'}`}>
                          <div className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-green-500' : 'bg-gray-300'}`} />
                        </div>
                        <span className="text-xs text-tertiary">{label}</span>
                        <span className={`text-[10px] font-bold ml-auto ${on ? 'text-green-600' : 'text-gray-400'}`}>{on ? 'ON' : 'OFF'}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Thumbnail placeholder */}
                <div className="w-32 flex-shrink-0">
                  <div className={`w-12 h-12 rounded-xl ${ICON_COLORS.find(c => c.id === selectedColor)?.bg ?? 'bg-primary'} flex items-center justify-center mx-auto mb-2`}>
                    <div className="w-5 h-5 bg-white/30 rounded" />
                  </div>
                  <div className="bg-bial-bg rounded-xl border border-bial-border h-24 flex flex-col items-center justify-center gap-1 p-2">
                    <div className="w-full h-2 bg-gray-200 rounded" />
                    <div className="w-3/4 h-2 bg-gray-100 rounded" />
                    <div className="w-full h-2 bg-gray-200 rounded mt-1" />
                    <div className="w-1/2 h-2 bg-gray-100 rounded" />
                  </div>
                  <p className="text-[10px] text-neutral text-center mt-1.5">App preview</p>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-3 pt-2 pb-10">
              <button
                onClick={() => navigate('/workspace/builder')}
                className="px-5 py-2.5 border border-bial-border rounded-xl text-sm font-semibold text-neutral hover:border-primary hover:text-primary transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveDraft}
                disabled={savingDraft}
                className="px-5 py-2.5 border border-bial-border rounded-xl text-sm font-semibold text-neutral hover:border-primary hover:text-primary transition disabled:opacity-60"
              >
                {savingDraft ? 'Saving...' : 'Save as Draft'}
              </button>
              <button
                onClick={handleDeploy}
                className="ml-auto px-6 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-xl text-sm font-bold transition shadow-sm shadow-primary/20"
              >
                Deploy Now
              </button>
            </div>
          </div>
        </div>
      </main>

      {showSuccess && <SuccessModal appName={appName} onClose={() => setShowSuccess(false)} />}
    </div>
  )
}
