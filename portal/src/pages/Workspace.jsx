import { useState, useEffect } from 'react'
import { Zap, Sparkles, Plus, Rocket, X, Lightbulb, Play } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/layout/Navbar'
import { workspaceDrafts } from '../data/mockData'

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
            3 Apps Active in Terminal 3
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
      </main>

      {/* Toast notification */}
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
    </div>
  )
}
