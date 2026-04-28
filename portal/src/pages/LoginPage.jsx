import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Lock, User, Building2, ArrowRight, Zap, Shield, Cloud } from 'lucide-react'
import BIALLogo from '../components/BIALLogo'

export default function LoginPage() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    if (!username || !password) {
      setError('Please enter your Staff ID and password.')
      return
    }
    setLoading(true)
    await new Promise((r) => setTimeout(r, 1000))
    setLoading(false)
    localStorage.setItem('bial_user', JSON.stringify({ username, name: 'Alex Chen', role: 'Terminal Lead', isAdmin: true }))
    navigate('/dashboard')
  }

  const handleSSO = async () => {
    setLoading(true)
    await new Promise((r) => setTimeout(r, 700))
    setLoading(false)
    localStorage.setItem('bial_user', JSON.stringify({ username: 'sso-user', name: 'Alex Chen', role: 'Terminal Lead', isAdmin: true }))
    navigate('/dashboard')
  }

  return (
    <div className="min-h-screen flex font-manrope">
      {/* Left panel */}
      <div
        className="hidden lg:flex lg:w-1/2 flex-col justify-between p-10 relative overflow-hidden"
        style={{ background: 'linear-gradient(155deg, #00818A 0%, #1A2B34 70%, #0a1a22 100%)' }}
      >
        <div className="absolute top-[-80px] right-[-80px] w-72 h-72 rounded-full bg-white opacity-5" />
        <div className="absolute bottom-[-100px] left-[-60px] w-80 h-80 rounded-full bg-white opacity-5" />
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none'%3E%3Cg fill='%23ffffff' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
          }}
        />

        <div className="relative z-10">
          <BIALLogo size={44} />
        </div>

        <div className="relative z-10 space-y-5">
          <span className="inline-block bg-secondary text-white text-xs font-worksans font-semibold tracking-widest uppercase px-3 py-1 rounded-full">
            Staff Internal Portal
          </span>
          <h1 className="text-5xl font-extrabold text-white leading-tight">
            Citizen<br />Developer
          </h1>
          <p className="text-teal-100 text-base leading-relaxed max-w-xs">
            Empowering airport staff to build operational tools and digital solutions for Terminal 2.
          </p>
        </div>

        <div className="relative z-10 flex gap-6">
          {[
            { icon: Zap, label: 'High Efficiency' },
            { icon: Shield, label: 'Secure Access' },
            { icon: Cloud, label: 'Cloud Integrated' },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-2 text-teal-200 text-sm">
              <Icon size={14} strokeWidth={1.5} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 bg-white">
        <div className="lg:hidden mb-8">
          <BIALLogo size={40} />
        </div>

        <div className="w-full max-w-sm">
          <div className="flex justify-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center shadow-lg shadow-primary/20">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3" />
                <rect x="9" y="11" width="14" height="10" rx="2" />
                <line x1="13" y1="16" x2="15" y2="16" />
              </svg>
            </div>
          </div>

          <h2 className="text-center text-2xl font-bold text-tertiary mb-1">Welcome Back</h2>
          <p className="text-center text-neutral text-sm mb-8">Access your workspace and tools</p>

          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-worksans font-semibold tracking-wider text-neutral uppercase mb-1.5">
                Staff Username
              </label>
              <div className="relative">
                <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral" />
                <input
                  type="text"
                  placeholder="BIAL-12345"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full pl-9 pr-4 py-3 border border-bial-border rounded-xl text-tertiary text-sm placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-worksans font-semibold tracking-wider text-neutral uppercase mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-9 pr-10 py-3 border border-bial-border rounded-xl text-tertiary text-sm placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral hover:text-primary transition"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="w-4 h-4 rounded accent-primary"
                />
                <span className="text-sm text-neutral">Remember me</span>
              </label>
              <button type="button" className="text-sm text-primary font-medium hover:underline">
                Forgot password?
              </button>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-600 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition shadow-md shadow-primary/20"
            >
              {loading ? (
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              ) : (
                <>Login with Staff ID <ArrowRight size={15} /></>
              )}
            </button>
          </form>

          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-bial-border" />
            <span className="text-xs text-neutral uppercase tracking-wider">or use sso</span>
            <div className="flex-1 h-px bg-bial-border" />
          </div>

          <button
            onClick={handleSSO}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 border-2 border-bial-border hover:border-primary hover:bg-primary/5 text-tertiary font-semibold py-3 rounded-xl transition"
          >
            <Building2 size={17} className="text-primary" />
            BIAL Corporate Login
          </button>

          <p className="text-center text-xs text-neutral mt-6">
            Need assistance? Contact{' '}
            <a href="#" className="text-primary font-medium hover:underline">IT Support Desk</a>
          </p>

          <div className="flex justify-center gap-4 mt-3">
            {['Privacy Policy', 'Security Standards', 'System Status'].map((link) => (
              <a key={link} href="#" className="text-[10px] text-neutral uppercase tracking-wider hover:text-primary transition">
                {link}
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
