import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, BarChart3, Database, Palette, Sparkles, LayoutGrid } from 'lucide-react'
import Navbar from '../components/layout/Navbar'

const EXAMPLES = [
  {
    icon: LayoutGrid,
    color: 'text-primary',
    bg: 'bg-primary/10',
    title: 'Resource Management',
    desc: '"Build a system to track gate equipment maintenance logs and schedules."',
  },
  {
    icon: Users,
    color: 'text-secondary',
    bg: 'bg-secondary/10',
    title: 'Staff Coordination',
    desc: '"An app for roster updates and emergency broadcast notifications for T1 teams."',
  },
  {
    icon: BarChart3,
    color: 'text-primary',
    bg: 'bg-primary/10',
    title: 'Flight Metrics',
    desc: '"Visual dashboard for tracking turn-around times by airline partner."',
  },
]

export default function SandboxPage() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')

  const handleGenerate = () => {
    if (!prompt.trim()) return
    navigate('/workspace/builder', { state: { prompt } })
  }

  return (
    <div className="min-h-screen bg-bial-bg font-manrope flex flex-col">
      <Navbar />

      {/* Main */}
      <main className="flex-1 flex flex-col items-center px-6 py-14">
        {/* <div className="mb-8">
          <BIALLogo size={36} />
        </div> */}

        <h1 className="text-4xl font-extrabold text-tertiary text-center mb-3">
          Build What You Need. No Code Required
        </h1>
        <p className="text-neutral text-center max-w-lg mb-10 leading-relaxed">
          Turn everyday operational ideas into working applications. Just describe what you need in plain English — the BLR Citizen Developer Suite handles the rest.
        </p>

        {/* Prompt card */}
        <div className="w-full max-w-2xl bg-white rounded-2xl border border-bial-border shadow-sm">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) handleGenerate() }}
            placeholder="Describe the app you want to build... (e.g. 'Create a dashboard to track terminal 2 ground staff assignments with real-time delay alerts')"
            rows={6}
            className="w-full p-5 text-sm text-tertiary placeholder:text-gray-300 resize-none focus:outline-none rounded-t-2xl font-manrope leading-relaxed"
          />
          <div className="flex items-center justify-between px-4 py-3 border-t border-bial-border">
            <div className="flex items-center gap-2">
              <button className="flex items-center gap-1.5 text-xs font-worksans font-medium text-neutral border border-bial-border rounded-full px-3 py-1.5 hover:border-primary hover:text-primary transition">
                <Database size={11} />
                Data Schema
              </button>
              <button className="flex items-center gap-1.5 text-xs font-worksans font-medium text-neutral border border-bial-border rounded-full px-3 py-1.5 hover:border-primary hover:text-primary transition">
                <Palette size={11} />
                BLR Theme
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1 text-xs text-primary font-worksans font-medium">
                <Sparkles size={11} />
                AI Ready
              </span>
              <button
                onClick={handleGenerate}
                disabled={!prompt.trim()}
                className="flex items-center gap-2 bg-secondary hover:bg-secondary-600 disabled:opacity-40 text-white font-bold text-sm px-5 py-2.5 rounded-xl transition shadow-sm shadow-secondary/30"
              >
                Generate App <Sparkles size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* Example cards */}
        <div className="w-full max-w-2xl mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          {EXAMPLES.map(({ icon: Icon, color, bg, title, desc }) => (
            <button
              key={title}
              onClick={() => setPrompt(desc.replace(/"/g, ''))}
              className="bg-white rounded-xl border border-bial-border p-4 text-left hover:border-primary hover:shadow-md transition group"
            >
              <div className={`w-9 h-9 rounded-xl ${bg} flex items-center justify-center mb-3`}>
                <Icon size={17} className={color} />
              </div>
              <h3 className="text-sm font-bold text-tertiary mb-1 group-hover:text-primary transition">{title}</h3>
              <p className="text-xs text-neutral leading-relaxed">{desc}</p>
            </button>
          ))}
        </div>
      </main>

      <footer className="border-t border-bial-border bg-white py-4 px-6">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <p className="text-xs text-neutral">© 2026 Bangalore International Airport · Citizen Developer Suite</p>
          <div className="flex gap-5">
            {['Privacy', 'Security', 'Staff Support'].map((l) => (
              <a key={l} href="#" className="text-xs text-neutral hover:text-primary transition">{l}</a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  )
}
