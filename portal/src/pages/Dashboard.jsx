import { useNavigate } from 'react-router-dom'
import { FileText, Rocket, Bot, ArrowRight } from 'lucide-react'
import Navbar from '../components/layout/Navbar'
import { getStoredUser } from '../utils/auth'

export default function Dashboard() {
  const navigate = useNavigate()

  const user = getStoredUser()
  const greetingName = user?.name || user?.username || 'there'

  return (
    <div className="min-h-screen font-manrope flex flex-col" style={{ background: 'linear-gradient(160deg, #ffffff 0%, #f0f9f9 100%)' }}>
      <Navbar />

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-14">
        {/* Welcome header */}
        <p className="text-xs font-worksans font-semibold tracking-widest uppercase text-primary mb-2">
          Welcome Back
        </p>
        <h1 className="text-4xl font-extrabold text-tertiary mb-3">
          Hello, {greetingName}
        </h1>
        {user?.role && (
          <p className="text-sm font-worksans font-semibold text-primary mb-3 capitalize">
            {user.role}
          </p>
        )}
        <p className="text-neutral text-base leading-relaxed max-w-2xl mb-10">
          Ready to build the future of aviation? Plan and build operational tools in the App Builder, or ask BIAL Chat anything.
        </p>

        {/* Two entry points — distinct identity + job-to-be-done copy (Decision 7) */}
        <div className="grid gap-5 sm:grid-cols-2 max-w-3xl">
          {/* App Builder — plan and build operational tools */}
          <div
            onClick={() => navigate('/workspace')}
            className="relative rounded-2xl p-6 flex flex-col overflow-hidden cursor-pointer transition-transform hover:-translate-y-1 bg-primary text-white shadow-xl shadow-primary/20"
          >
            <div className="absolute top-0 right-0 w-32 h-32 rounded-bl-full opacity-10 bg-white" />

            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4 bg-white/20 text-white">
              <FileText size={18} />
            </div>

            <h2 className="text-lg font-bold mb-2 text-white">App Builder</h2>
            <p className="text-sm leading-relaxed flex-1 mb-6 text-white/80">
              Plan and build an operational tool — flight tracking, rostering, baggage, gate management — then deploy it.
            </p>

            <button className="flex items-center gap-1 text-sm font-semibold text-white hover:text-white/80 transition">
              Open App Builder
              <Rocket size={14} />
            </button>
          </div>

          {/* BIAL Chat — general assistant (distinct icon, dark identity, JTBD copy) */}
          <div
            onClick={() => navigate('/chat')}
            className="relative rounded-2xl p-6 flex flex-col overflow-hidden cursor-pointer transition-transform hover:-translate-y-1 bg-tertiary text-white shadow-xl shadow-tertiary/20"
          >
            <div className="absolute top-0 right-0 w-32 h-32 rounded-bl-full opacity-10 bg-white" />

            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4 bg-white/20 text-white">
              <Bot size={18} />
            </div>

            <h2 className="text-lg font-bold mb-2 text-white">BIAL Chat</h2>
            <p className="text-sm leading-relaxed flex-1 mb-6 text-white/80">
              Ask anything — draft, summarize, or analyze a file. A general-purpose AI assistant for everyday work.
            </p>

            <button className="flex items-center gap-1 text-sm font-semibold text-white hover:text-white/80 transition">
              Open BIAL Chat
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </main>

      <footer className="border-t border-bial-border bg-white py-4 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <p className="text-xs text-neutral">Kempegowda International Airport Bengaluru &middot; V 2.4.0-Build</p>
          <div className="flex gap-5">
            <button
              onClick={() => navigate('/help')}
              className="text-xs text-neutral hover:text-primary transition"
            >
              Support
            </button>
          </div>
        </div>
      </footer>
    </div>
  )
}
