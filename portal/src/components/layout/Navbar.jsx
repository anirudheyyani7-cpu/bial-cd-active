import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Bell, Settings, HelpCircle, Search, ChevronDown, LogOut, User } from 'lucide-react'

const NAV_LINKS = [
  { label: 'My Workspace', to: '/workspace' },
  { label: 'Team Space', to: '/teamspace' },
  { label: 'Enterprise Space', to: '/enterprise' },
  { label: 'Help', to: '/help' },
]

export default function Navbar() {
  const navigate = useNavigate()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const user = JSON.parse(localStorage.getItem('bial_user') || '{}')

  const handleLogout = () => {
    localStorage.removeItem('bial_user')
    navigate('/login')
  }

  return (
    <nav className="bg-white border-b border-bial-border sticky top-0 z-40 flex-shrink-0">
      <div className="px-6 h-14 flex items-center justify-between gap-4">
        {/* Brand */}
        <NavLink
          to="/dashboard"
          className="text-primary font-bold text-lg tracking-tight whitespace-nowrap"
        >
          BIAL Citizen Developer
        </NavLink>

        {/* Nav links */}
        <div className="hidden md:flex items-center gap-6">
          {NAV_LINKS.map(({ label, to }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `text-sm font-medium transition pb-0.5 ${
                  isActive
                    ? 'text-primary font-bold border-b-2 border-primary'
                    : 'text-neutral hover:text-primary'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2">
          <div className="hidden lg:flex items-center gap-2 bg-surface-muted border border-bial-border rounded-lg px-3 py-1.5">
            <Search size={13} className="text-neutral" />
            <input
              type="text"
              placeholder="Search workspace..."
              className="bg-transparent text-sm text-tertiary placeholder:text-gray-400 focus:outline-none w-40"
            />
          </div>

          <button className="p-2 text-neutral hover:text-primary transition rounded-lg hover:bg-surface-muted relative">
            <Bell size={17} />
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-accent rounded-full" />
          </button>

          <button className="p-2 text-neutral hover:text-primary transition rounded-lg hover:bg-surface-muted">
            <Settings size={17} />
          </button>

          <button className="p-2 text-neutral hover:text-primary transition rounded-lg hover:bg-surface-muted">
            <HelpCircle size={17} />
          </button>

          {/* User avatar */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-surface-muted transition"
            >
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold">
                {(user.name || 'U').charAt(0).toUpperCase()}
              </div>
              <div className="hidden lg:block text-left">
                <p className="text-xs font-semibold text-tertiary leading-tight">{user.name || 'Alex Chen'}</p>
                <p className="text-[10px] text-neutral leading-tight">{user.role || 'Terminal Lead'}</p>
              </div>
              <ChevronDown size={13} className="text-neutral hidden lg:block" />
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-11 w-48 bg-white rounded-xl border border-bial-border shadow-xl py-2 z-50">
                <div className="px-4 py-2 border-b border-bial-border">
                  <p className="text-xs font-semibold text-tertiary">{user.name || 'Alex Chen'}</p>
                  <p className="text-xs text-neutral">{user.username || 'Terminal Lead'}</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-danger hover:bg-red-50 transition"
                >
                  <LogOut size={13} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  )
}
