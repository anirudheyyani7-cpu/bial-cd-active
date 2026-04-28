import { useState, useRef, useEffect } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  Bell, Settings, Search, ChevronDown, LogOut, User,
  CheckCircle, MessageSquare, Shield, Wrench,
  LayoutGrid, Users, FileText, Plus, Inbox,
  UserCircle, BookOpen, Info, Monitor,
} from 'lucide-react'

const NAV_LINKS = [
  { label: 'My Workspace', to: '/workspace' },
  { label: 'Team Space', to: '/teamspace' },
  { label: 'Enterprise Space', to: '/enterprise' },
  { label: 'Help', to: '/help' },
]

const ADMIN_LINK = { label: 'Admin', to: '/admin' }

const NOTIFICATIONS = [
  { id: 1, icon: CheckCircle, iconColor: 'text-green-500', title: "Your app 'Gate 42 Delay Log' was deployed successfully", time: '2h ago' },
  { id: 2, icon: MessageSquare, iconColor: 'text-primary', title: 'Arjun K. commented on Cab Booking app', time: '4h ago' },
  { id: 3, icon: Shield, iconColor: 'text-blue-500', title: 'Enterprise review approved for EcoTerminal Monitor', time: '1 day ago' },
  { id: 4, icon: Wrench, iconColor: 'text-secondary', title: 'System maintenance scheduled for Terminal 3 servers', time: '2 days ago' },
]

const SETTINGS_ITEMS = [
  { icon: UserCircle, label: 'Profile Settings' },
  { icon: Bell, label: 'Notification Preferences' },
  { icon: Monitor, label: 'Display & Accessibility' },
  { icon: Info, label: 'About BIAL Citizen Developer' },
]

const SEARCH_PAGES = [
  { label: 'My Workspace', to: '/workspace', icon: FileText },
  { label: 'Team Space', to: '/teamspace', icon: Users },
  { label: 'Enterprise Space', to: '/enterprise', icon: LayoutGrid },
  { label: 'Help Center', to: '/help', icon: BookOpen },
]

const SEARCH_APPS = [
  { label: 'CargoTracker Pro', to: '/enterprise' },
  { label: 'StaffGuard ID', to: '/enterprise' },
  { label: 'Concierge Connect', to: '/enterprise' },
  { label: 'EcoTerminal Monitor', to: '/enterprise' },
  { label: 'OpsScript Lite', to: '/enterprise' },
]

const SEARCH_ACTIONS = [
  { label: 'Create New App', to: '/workspace/sandbox', icon: Plus },
  { label: 'View Drafts', to: '/workspace', icon: Inbox },
]

function useClickOutside(ref, handler) {
  useEffect(() => {
    const listener = (e) => { if (ref.current && !ref.current.contains(e.target)) handler() }
    document.addEventListener('mousedown', listener)
    return () => document.removeEventListener('mousedown', listener)
  }, [ref, handler])
}

export default function Navbar() {
  const navigate = useNavigate()
  const [activeDropdown, setActiveDropdown] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [toastMsg, setToastMsg] = useState(null)
  const user = JSON.parse(localStorage.getItem('bial_user') || '{}')

  const navRef = useRef(null)
  const toastTimer = useRef(null)

  useClickOutside(navRef, () => setActiveDropdown(null))

  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') { setActiveDropdown(null); setSearchQuery('') } }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [])

  const toggle = (name) => setActiveDropdown((prev) => (prev === name ? null : name))

  const showToast = (msg) => {
    setToastMsg(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 3000)
  }

  const handleLogout = () => {
    localStorage.removeItem('bial_user')
    navigate('/login')
  }

  const handleNav = (to) => {
    setActiveDropdown(null)
    setSearchQuery('')
    navigate(to)
  }

  const filteredSearch = searchQuery.trim()
    ? {
        pages: SEARCH_PAGES.filter((p) => p.label.toLowerCase().includes(searchQuery.toLowerCase())),
        apps: SEARCH_APPS.filter((a) => a.label.toLowerCase().includes(searchQuery.toLowerCase())),
        actions: SEARCH_ACTIONS.filter((a) => a.label.toLowerCase().includes(searchQuery.toLowerCase())),
      }
    : null

  return (
    <>
      <nav ref={navRef} className="bg-white border-b border-bial-border sticky top-0 z-40 flex-shrink-0">
        <div className="px-6 h-14 flex items-center justify-between gap-4">
          {/* Brand + Nav */}
          <div className="flex items-center gap-8">
            <NavLink to="/dashboard" className="text-primary font-bold text-lg tracking-tight whitespace-nowrap">
              BIAL Citizen Developer
            </NavLink>
            <div className="hidden md:flex items-center gap-6">
              {[...NAV_LINKS, ...(user.isAdmin ? [ADMIN_LINK] : [])].map(({ label, to }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `text-sm font-medium transition pb-0.5 ${
                      isActive ? 'text-primary font-bold border-b-2 border-primary' : 'text-neutral hover:text-primary'
                    }`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </div>
          </div>

          {/* Right cluster */}
          <div className="flex items-center gap-1">
            {/* Search */}
            <div className="relative hidden lg:block">
              <div
                className="flex items-center gap-2 bg-surface-muted border border-bial-border rounded-lg px-3 py-1.5 cursor-text"
                onClick={() => { setActiveDropdown('search'); }}
              >
                <Search size={13} className="text-neutral flex-shrink-0" />
                <input
                  type="text"
                  placeholder="Search apps, pages, or actions..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setActiveDropdown('search') }}
                  className="bg-transparent text-sm text-tertiary placeholder:text-gray-400 focus:outline-none w-48"
                  onFocus={() => setActiveDropdown('search')}
                />
              </div>

              {activeDropdown === 'search' && (
                <div className="absolute top-full right-0 mt-1.5 w-72 bg-white rounded-xl border border-bial-border shadow-xl z-50 py-2 overflow-hidden">
                  {filteredSearch ? (
                    <>
                      {filteredSearch.pages.length > 0 && (
                        <div>
                          <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral">Pages</p>
                          {filteredSearch.pages.map((p) => (
                            <button key={p.to} onClick={() => handleNav(p.to)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bial-bg transition text-left">
                              <p.icon size={13} className="text-primary flex-shrink-0" />
                              <span className="text-sm text-tertiary">{p.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {filteredSearch.apps.length > 0 && (
                        <div>
                          <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral border-t border-bial-border mt-1">Apps</p>
                          {filteredSearch.apps.map((a) => (
                            <button key={a.label} onClick={() => handleNav(a.to)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bial-bg transition text-left">
                              <div className="w-5 h-5 rounded bg-primary/10 flex-shrink-0" />
                              <span className="text-sm text-tertiary">{a.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {filteredSearch.actions.length > 0 && (
                        <div>
                          <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral border-t border-bial-border mt-1">Actions</p>
                          {filteredSearch.actions.map((a) => (
                            <button key={a.label} onClick={() => handleNav(a.to)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bial-bg transition text-left">
                              <a.icon size={13} className="text-primary flex-shrink-0" />
                              <span className="text-sm text-tertiary">{a.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {!filteredSearch.pages.length && !filteredSearch.apps.length && !filteredSearch.actions.length && (
                        <p className="px-4 py-3 text-sm text-neutral text-center">No results for "{searchQuery}"</p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral">Pages</p>
                      {SEARCH_PAGES.map((p) => (
                        <button key={p.to} onClick={() => handleNav(p.to)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bial-bg transition text-left">
                          <p.icon size={13} className="text-primary flex-shrink-0" />
                          <span className="text-sm text-tertiary">{p.label}</span>
                        </button>
                      ))}
                      <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral border-t border-bial-border mt-1">Quick Actions</p>
                      {SEARCH_ACTIONS.map((a) => (
                        <button key={a.label} onClick={() => handleNav(a.to)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bial-bg transition text-left">
                          <a.icon size={13} className="text-primary flex-shrink-0" />
                          <span className="text-sm text-tertiary">{a.label}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Bell */}
            <div className="relative">
              <button
                onClick={() => toggle('bell')}
                className="p-2 text-neutral hover:text-primary transition rounded-lg hover:bg-surface-muted relative"
              >
                <Bell size={17} />
                <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-accent rounded-full" />
              </button>
              {activeDropdown === 'bell' && (
                <div className="absolute right-0 top-11 w-80 bg-white rounded-xl border border-bial-border shadow-xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-bial-border flex items-center justify-between">
                    <p className="text-sm font-bold text-tertiary">Notifications</p>
                    <span className="text-[10px] bg-primary/10 text-primary font-bold px-2 py-0.5 rounded-full">4 new</span>
                  </div>
                  <div className="divide-y divide-bial-border">
                    {NOTIFICATIONS.map(({ id, icon: Icon, iconColor, title, time }) => (
                      <div key={id} className="flex items-start gap-3 px-4 py-3 hover:bg-bial-bg transition cursor-pointer">
                        <Icon size={15} className={`${iconColor} flex-shrink-0 mt-0.5`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-tertiary leading-relaxed">{title}</p>
                          <p className="text-[10px] text-neutral mt-0.5">{time}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 py-2.5 border-t border-bial-border">
                    <button className="text-xs text-primary font-semibold hover:underline">View All Notifications</button>
                  </div>
                </div>
              )}
            </div>

            {/* Settings */}
            <div className="relative">
              <button
                onClick={() => toggle('settings')}
                className="p-2 text-neutral hover:text-primary transition rounded-lg hover:bg-surface-muted"
              >
                <Settings size={17} />
              </button>
              {activeDropdown === 'settings' && (
                <div className="absolute right-0 top-11 w-52 bg-white rounded-xl border border-bial-border shadow-xl z-50 py-2 overflow-hidden">
                  {SETTINGS_ITEMS.map(({ icon: Icon, label }) => (
                    <button
                      key={label}
                      onClick={() => { setActiveDropdown(null); showToast('Coming soon') }}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-tertiary hover:bg-bial-bg transition text-left"
                    >
                      <Icon size={14} className="text-neutral flex-shrink-0" />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* User avatar */}
            <div className="relative">
              <button
                onClick={() => toggle('user')}
                className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-surface-muted transition"
              >
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold">
                  {(user.name || 'U').charAt(0).toUpperCase()}
                </div>
                <div className="hidden lg:block text-left">
                  <p className="text-xs font-semibold text-tertiary leading-tight">{user.name || 'Sushant'}</p>
                  <p className="text-[10px] text-neutral leading-tight">{user.role || 'Terminal Lead'}</p>
                </div>
                <ChevronDown size={13} className="text-neutral hidden lg:block" />
              </button>

              {activeDropdown === 'user' && (
                <div className="absolute right-0 top-11 w-52 bg-white rounded-xl border border-bial-border shadow-xl py-2 z-50">
                  <div className="px-4 py-2.5 border-b border-bial-border">
                    <p className="text-xs font-bold text-tertiary">{user.name || 'Sushant'}</p>
                    <p className="text-[10px] text-neutral">{user.role || 'Terminal Lead'}</p>
                  </div>
                  <button
                    onClick={() => { setActiveDropdown(null); showToast('Coming soon') }}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-tertiary hover:bg-bial-bg transition"
                  >
                    <User size={13} className="text-neutral flex-shrink-0" />
                    My Profile
                  </button>
                  <button
                    onClick={() => handleNav('/workspace')}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-tertiary hover:bg-bial-bg transition"
                  >
                    <FileText size={13} className="text-neutral flex-shrink-0" />
                    My Drafts
                  </button>
                  <div className="border-t border-bial-border mt-1 pt-1">
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-danger hover:bg-red-50 transition"
                    >
                      <LogOut size={13} />
                      Sign out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-6 right-6 z-50 bg-white border border-bial-border rounded-xl shadow-xl px-4 py-3 text-sm text-tertiary font-medium flex items-center gap-2">
          <Info size={14} className="text-primary flex-shrink-0" />
          {toastMsg}
        </div>
      )}
    </>
  )
}
