import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, ChevronDown, Plus, Users, BarChart3, Database, Palette, Sparkles, LogOut, LayoutGrid, User } from 'lucide-react'
import SkyLinkLogo from '../components/SkyLinkLogo'
import BIALLogo from '../components/BIALLogo'

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
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const user = JSON.parse(localStorage.getItem('bial_user') || '{}')

  const handleGenerate = () => {
    if (!prompt.trim()) return
    navigate('/builder', { state: { prompt } })
  }

  const handleLogout = () => {
    localStorage.removeItem('bial_user')
    navigate('/')
  }

  return (
    <div className="min-h-screen bg-bial-bg font-manrope flex flex-col">
      {/* Navbar */}
      <nav className="bg-white border-b border-bial-border sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <SkyLinkLogo />
            <div className="hidden md:flex items-center gap-6">
              {['My Apps', 'Help'].map((item) => (
                <a key={item} href="#" className="text-sm text-neutral hover:text-primary transition font-medium">{item}</a>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="relative p-2 text-neutral hover:text-primary transition rounded-lg hover:bg-bial-bg">
              <Bell size={17} />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-secondary rounded-full" />
            </button>
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-bial-bg transition"
              >
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                  <User size={13} className="text-primary" />
                </div>
                <ChevronDown size={13} className="text-neutral" />
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-10 w-48 bg-white rounded-xl border border-bial-border shadow-xl py-2 z-50">
                  <div className="px-4 py-2 border-b border-bial-border">
                    <p className="text-xs font-semibold text-tertiary">{user.name || 'Staff Member'}</p>
                    <p className="text-xs text-neutral">{user.username || 'BIAL Staff'}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-500 hover:bg-red-50 transition"
                  >
                    <LogOut size={13} />
                    Sign out
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => setPrompt('')}
              className="flex items-center gap-1.5 bg-primary hover:bg-primary-600 text-white text-sm font-semibold px-4 py-2 rounded-xl transition shadow-sm"
            >
              <Plus size={14} />
              Create New
            </button>
          </div>
        </div>
      </nav>

      {/* Main */}
      <main className="flex-1 flex flex-col items-center px-6 py-14">
        <div className="mb-8">
          <BIALLogo size={36} />
        </div>

        <h1 className="text-4xl font-extrabold text-tertiary text-center mb-3">
          Sandbox — Start Building
        </h1>
        <p className="text-neutral text-center max-w-lg mb-10 leading-relaxed">
          Empower your workflow at Bangalore International Airport. Describe your vision in plain English and watch the BLR Citizen Developer suite bring it to life.
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
          <p className="text-xs text-neutral">© 2024 Airport Operations Citizen Developer Suite</p>
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
