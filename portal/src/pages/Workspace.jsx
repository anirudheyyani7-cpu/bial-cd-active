import { useState, useEffect } from 'react'
import { Zap, Sparkles, Plus, Rocket, X, Lightbulb, Play, BarChart2, Clock, Users, TrendingUp, TrendingDown, MoreVertical } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/layout/Navbar'
import { workspaceDrafts, mockUsageStats } from '../data/mockData'

const VIBE_STEPS = [
  { n: 1, text: 'Type a prompt explaining the intent and data source.' },
  { n: 2, text: 'Review the generated Logic View and adjust UI components visually.' },
  { n: 3, text: 'Click Deploy to push the app to the terminal dashboard.' },
]

function DraftCard({ draft, onClick }) {
  return (
    <div
      onClick={onClick}
      className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex flex-col gap-3 cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition"
    >
      <div className="flex items-start justify-between">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${draft.iconColor}`}>
          <Zap size={16} />
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${draft.statusColor}`}>
          {draft.status}
        </span>
      </div>
      <div>
        <h3 className="text-sm font-bold text-tertiary mb-1">{draft.name}</h3>
        <p className="text-xs text-neutral leading-relaxed">{draft.description}</p>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-gray-50">
        <div className="flex -space-x-1.5">
          {Array.from({ length: draft.avatarCount }).map((_, i) => (
            <div key={i} className="w-6 h-6 rounded-full bg-primary/10 border border-white flex items-center justify-center text-[9px] font-bold text-primary">
              {['AK', 'PS'][i] || 'U'}
            </div>
          ))}
        </div>
        <span className="text-[10px] text-neutral">Modified {draft.modifiedAgo}</span>
      </div>
    </div>
  )
}

export default function Workspace() {
  const navigate = useNavigate()
  const [showToast, setShowToast] = useState(true)
  const [timeFilter, setTimeFilter] = useState('30d')
  const [usageApps, setUsageApps] = useState(mockUsageStats)
  const [activeMenu, setActiveMenu] = useState(null)
  const [deactivateTarget, setDeactivateTarget] = useState(null)
  const [actionToast, setActionToast] = useState(null)

  const showActionToast = (msg) => {
    setActionToast(msg)
    setTimeout(() => setActionToast(null), 3000)
  }

  const confirmDeactivate = () => {
    setUsageApps((apps) =>
      apps.map((a) => (a.name === deactivateTarget ? { ...a, status: 'inactive' } : a))
    )
    setDeactivateTarget(null)
    showActionToast('App deactivated')
  }

  useEffect(() => {
    const timer = setTimeout(() => setShowToast(false), 5000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="min-h-screen bg-surface-muted font-manrope flex flex-col">
      <Navbar />

      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-extrabold text-tertiary mb-1">My Workspace</h1>
            <p className="text-neutral text-sm max-w-xl leading-relaxed">
              Manage your ongoing development projects and deploy operational tools directly to the terminal floor.
            </p>
          </div>
          <span className="flex items-center gap-2 bg-accent text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-sm">
            <Rocket size={12} />
            3 Apps Active in My Workspace
          </span>
        </div>

        {/* Hero section — two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-10">
          {/* Hero CTA card */}
          <div className="lg:col-span-2 bg-primary rounded-2xl p-10 flex flex-col items-center justify-center text-center shadow-xl shadow-primary/20 relative overflow-hidden min-h-72">
            {/* Decorative rings */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-64 h-64 rounded-full border border-white/5" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-96 h-96 rounded-full border border-white/5" />
            </div>

            <div className="relative z-10 flex flex-col items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-accent flex items-center justify-center shadow-lg">
                <Zap size={24} className="text-white" />
              </div>
              <h2 className="text-2xl font-extrabold text-white leading-tight max-w-sm">
                What operational tool do you want to build today?
              </h2>
              <p className="text-white/70 text-sm max-w-sm leading-relaxed">
                Describe your idea in plain English. Our AI-driven sandbox will handle the code while you focus on the workflow.
              </p>
              <button
                onClick={() => navigate('/workspace/sandbox')}
                className="flex items-center gap-2 bg-accent hover:bg-yellow-500 text-white font-bold px-6 py-3 rounded-xl transition shadow-md mt-2"
              >
                Create New App <Sparkles size={15} />
              </button>
              <div className="flex items-center gap-2 bg-white/10 text-white/80 text-xs px-4 py-2 rounded-full mt-1">
                <Lightbulb size={12} />
                Try: "Build a baggage delay tracker for Gate B12"
              </div>
            </div>
          </div>

          {/* Right sidebar */}
          <div className="flex flex-col gap-4">
            {/* Vibe Coding 101 */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex-1">
              <p className="text-xs font-worksans font-semibold text-neutral uppercase tracking-wider mb-4">
                Vibe Coding 101
              </p>
              <div className="space-y-3">
                {VIBE_STEPS.map(({ n, text }) => (
                  <div key={n} className="flex gap-3 items-start">
                    <span className="w-5 h-5 rounded-full bg-primary text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {n}
                    </span>
                    <p className="text-xs text-neutral leading-relaxed">{text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Demo video thumbnail */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden cursor-pointer hover:shadow-md transition">
              <div className="relative h-32 bg-gradient-to-br from-primary/80 to-primary/40 flex items-center justify-center">
                <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center">
                  <Play size={20} className="text-white ml-1" />
                </div>
              </div>
              <div className="px-4 py-2">
                <p className="text-xs font-semibold text-tertiary">2:45 Demo Video</p>
              </div>
            </div>
          </div>
        </div>

        {/* Work in progress */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-tertiary">Work in Progress</h2>
            <button className="text-xs text-primary font-semibold hover:underline">View all drafts</button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {workspaceDrafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                onClick={() => navigate('/workspace/sandbox')}
              />
            ))}

            {/* Empty + card */}
            <button
              onClick={() => navigate('/workspace/sandbox')}
              className="bg-white rounded-xl border-2 border-dashed border-gray-200 p-5 flex items-center justify-center text-gray-300 hover:border-primary hover:text-primary transition min-h-40"
            >
              <Plus size={28} />
            </button>
          </div>
        </div>

        {/* Usage Statistics */}
        <div className="mt-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-tertiary">Usage Statistics</h2>
              <p className="text-xs text-neutral mt-0.5">Track how your deployed apps are performing across the terminal.</p>
            </div>
            <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-xl p-1">
              {[{ id: '7d', label: 'Last 7 Days' }, { id: '30d', label: 'Last 30 Days' }, { id: 'all', label: 'All Time' }].map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setTimeFilter(id)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition ${timeFilter === id ? 'bg-primary text-white shadow-sm' : 'text-neutral hover:text-tertiary'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Stat cards row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
            {[
              { icon: Rocket, label: 'Apps Deployed', value: '3', trend: '+1 this month', up: true },
              { icon: Users, label: 'Total Users', value: '47', trend: '+12 this month', up: true },
              { icon: BarChart2, label: 'Total Sessions', value: '1,284', trend: '+18% vs last period', up: true },
              { icon: Clock, label: 'Avg Session Time', value: '4.2 min', trend: '-0.3 min vs last period', up: false },
            ].map(({ icon: Icon, label, value, trend, up }) => (
              <div key={label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Icon size={14} className="text-primary" />
                  </div>
                  <span className="text-[10px] font-worksans font-semibold text-neutral uppercase tracking-wide">{label}</span>
                </div>
                <p className="text-2xl font-extrabold text-tertiary mb-1">{value}</p>
                <p className={`text-[10px] font-semibold flex items-center gap-1 ${up ? 'text-green-600' : 'text-secondary'}`}>
                  {up ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                  {trend}
                </p>
              </div>
            ))}
          </div>

          {/* Apps table */}
          {activeMenu !== null && (
            <div className="fixed inset-0 z-10" onClick={() => setActiveMenu(null)} />
          )}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  {['App Name', 'Status', 'Deployed To', 'Total Users', 'Sessions (30d)', 'Last Accessed', 'Actions'].map((col) => (
                    <th key={col} className="text-left text-[10px] font-worksans font-semibold text-neutral uppercase tracking-wide px-4 py-3">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {usageApps.map((app, i) => {
                  const statusClass = app.status === 'active'
                    ? 'bg-green-100 text-green-700'
                    : app.status === 'under review'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-500'
                  const statusLabel = app.status === 'active' ? 'Active' : app.status === 'under review' ? 'Under Review' : 'Inactive'
                  return (
                    <tr key={app.name} className="border-b border-gray-100 hover:bg-gray-50 transition">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                            <Zap size={13} className="text-primary" />
                          </div>
                          <span className="text-xs font-semibold text-tertiary">{app.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusClass}`}>{statusLabel}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral">{app.deployedTo}</td>
                      <td className="px-4 py-3 text-xs text-tertiary font-semibold">{app.totalUsers}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-tertiary font-semibold">{app.sessions30d.toLocaleString()}</span>
                          {app.trend === 'up' ? <TrendingUp size={12} className="text-green-500" /> : <TrendingDown size={12} className="text-red-400" />}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral">{app.lastAccessed}</td>
                      <td className="px-4 py-3">
                        <div className="relative z-20">
                          <button
                            onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === i ? null : i) }}
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-neutral transition"
                          >
                            <MoreVertical size={14} />
                          </button>
                          {activeMenu === i && (
                            <div className="absolute right-0 top-full mt-1 bg-white rounded-xl border border-gray-100 shadow-xl z-30 py-1 min-w-36 overflow-hidden">
                              <button
                                onClick={() => { setActiveMenu(null); showActionToast('App details coming soon') }}
                                className="w-full text-left px-4 py-2 text-xs hover:bg-gray-50 text-tertiary"
                              >
                                View Details
                              </button>
                              <button
                                onClick={() => { setActiveMenu(null); navigate('/workspace/builder') }}
                                className="w-full text-left px-4 py-2 text-xs hover:bg-gray-50 text-tertiary"
                              >
                                Edit App
                              </button>
                              <button
                                onClick={() => { setActiveMenu(null); setDeactivateTarget(app.name) }}
                                className="w-full text-left px-4 py-2 text-xs hover:bg-gray-50 text-red-500"
                              >
                                Deactivate
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Deployment success toast */}
      {showToast && (
        <div className="fixed bottom-6 right-6 flex items-start gap-3 bg-white rounded-xl shadow-xl border border-gray-100 p-4 max-w-xs z-50">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Rocket size={14} className="text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-bold text-tertiary mb-0.5">Deployment Success!</p>
            <p className="text-xs text-neutral leading-snug">Terminal Wayfinding AI is now live on all kiosks.</p>
          </div>
          <button onClick={() => setShowToast(false)} className="text-neutral hover:text-tertiary flex-shrink-0 -mt-0.5">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Action toast */}
      {actionToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-tertiary text-white text-xs font-semibold px-5 py-3 rounded-xl shadow-xl z-50">
          {actionToast}
        </div>
      )}

      {/* Deactivate confirmation modal */}
      {deactivateTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6">
            <h3 className="text-sm font-extrabold text-tertiary mb-2">Deactivate App?</h3>
            <p className="text-xs text-neutral leading-relaxed mb-6">
              Are you sure? This will make <span className="font-bold text-tertiary">{deactivateTarget}</span> unavailable to users.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeactivateTarget(null)}
                className="text-sm font-semibold text-neutral border border-gray-200 px-4 py-2 rounded-xl hover:border-gray-300 transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeactivate}
                className="text-sm font-bold bg-red-500 text-white px-5 py-2 rounded-xl hover:bg-red-600 transition"
              >
                Deactivate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
