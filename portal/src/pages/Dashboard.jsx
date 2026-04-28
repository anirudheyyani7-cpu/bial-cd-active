import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Users, FileText, ChevronRight, Rocket } from 'lucide-react'
import Navbar from '../components/layout/Navbar'

const WORKSPACE_CARDS = [
  {
    id: 'enterprise',
    title: 'Enterprise Space',
    description: 'Access official apps published by IT. Secured, compliant, and ready for terminal-wide deployment.',
    icon: LayoutGrid,
    iconBg: 'bg-primary/10 text-primary',
    linkLabel: 'Enter Space',
    to: '/enterprise',
    highlight: false,
  },
  {
    id: 'team',
    title: 'My Team Space',
    description: 'Collaborate on tools specific to your department. Share logic, data, and prototypes with teammates.',
    icon: Users,
    iconBg: 'bg-accent-light text-accent',
    linkLabel: 'View Team Hub',
    to: '/teamspace',
    highlight: false,
  },
  {
    id: 'workspace',
    title: 'My Workspace',
    description: 'Your personal sandbox for building and managing your apps. Create, test, and refine your ideas in private.',
    icon: FileText,
    iconBg: 'bg-white/20 text-white',
    linkLabel: 'Go to Sandbox',
    to: '/workspace',
    highlight: true,
  },
]

export default function Dashboard() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen font-manrope flex flex-col" style={{ background: 'linear-gradient(160deg, #ffffff 0%, #f0f9f9 100%)' }}>
      <Navbar />

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-14">
        {/* Welcome header */}
        <p className="text-xs font-worksans font-semibold tracking-widest uppercase text-primary mb-2">
          Welcome Back
        </p>
        <h1 className="text-4xl font-extrabold text-tertiary mb-3">
          Hello, Alex from Terminal Operations Team
        </h1>
        <p className="text-neutral text-base leading-relaxed max-w-2xl mb-10">
          Ready to build the future of aviation? Select a workspace to continue developing your custom tools and department workflows.
        </p>

        {/* Three workspace cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          {WORKSPACE_CARDS.map(({ id, title, description, icon: Icon, iconBg, linkLabel, to, highlight }) => (
            <div
              key={id}
              className={`relative rounded-2xl p-6 flex flex-col overflow-hidden cursor-pointer transition-transform hover:-translate-y-1 ${
                highlight
                  ? 'bg-primary text-white shadow-xl shadow-primary/20'
                  : 'bg-white border border-gray-100 shadow-sm'
              }`}
              onClick={() => navigate(to)}
            >
              {/* Decorative watermark */}
              <div className={`absolute top-0 right-0 w-32 h-32 rounded-bl-full opacity-10 ${highlight ? 'bg-white' : 'bg-primary'}`} />

              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${iconBg}`}>
                <Icon size={18} />
              </div>

              <h2 className={`text-lg font-bold mb-2 ${highlight ? 'text-white' : 'text-tertiary'}`}>
                {title}
              </h2>
              <p className={`text-sm leading-relaxed flex-1 mb-6 ${highlight ? 'text-white/80' : 'text-neutral'}`}>
                {description}
              </p>

              <button
                className={`flex items-center gap-1 text-sm font-semibold transition ${
                  highlight ? 'text-white hover:text-white/80' : 'text-primary hover:text-primary-dark'
                }`}
              >
                {linkLabel}
                {highlight ? <Rocket size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
          ))}
        </div>

        {/* Recent activity bar */}
        <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex items-center gap-3 flex-1">
            <div className="flex -space-x-2">
              {['AK', 'PS'].map((initials) => (
                <div
                  key={initials}
                  className="w-8 h-8 rounded-full bg-primary/10 border-2 border-white flex items-center justify-center text-xs font-bold text-primary"
                >
                  {initials}
                </div>
              ))}
              <div className="w-8 h-8 rounded-full bg-surface-muted border-2 border-white flex items-center justify-center text-xs font-semibold text-neutral">
                +12
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold text-tertiary">Terminal 2 Efficiency App</p>
              <p className="text-xs text-neutral">Last edited 2 hours ago by your team</p>
            </div>
          </div>
          <div className="flex gap-3">
            <button className="px-4 py-2 text-sm font-semibold border border-bial-border rounded-lg text-neutral hover:border-primary hover:text-primary transition">
              View Changelog
            </button>
            <button
              onClick={() => navigate('/workspace/sandbox')}
              className="px-4 py-2 text-sm font-semibold bg-primary text-white rounded-lg hover:bg-primary-dark transition"
            >
              Create New Prompt
            </button>
          </div>
        </div>
      </main>

      <footer className="border-t border-bial-border bg-white py-4 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <p className="text-xs text-neutral">Kempegowda International Airport Bengaluru &middot; V 2.4.0-Build</p>
          <div className="flex gap-5">
            {['System Status', 'Support'].map((l) => (
              <a key={l} href="#" className="text-xs text-neutral hover:text-primary transition">{l}</a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  )
}
