import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, BarChart3, Database, Palette, Sparkles, LayoutGrid, Car, ChevronDown } from 'lucide-react'
import Navbar from '../components/layout/Navbar'

const DATA_SOURCES = [
  { id: 'aodb', name: 'AODB', subtitle: 'Airport Operations Database' },
  { id: 'dar', name: 'DAR', subtitle: 'Daily Airport Report' },
  { id: 'vision', name: 'Vision Analytics System', subtitle: 'Camera and sensor analytics' },
  { id: 'namaskara', name: 'Namaskara Terminal', subtitle: 'Terminal Updates' },
  { id: 'xovis', name: 'Xovis', subtitle: 'Video Analytics Powered Crowd Management' },
  { id: 'fids', name: 'Flight Information Display (FIDS)', subtitle: 'Real-time flight status data' },
  { id: 'bhs', name: 'BHS Telemetry', subtitle: 'Baggage handling system sensors' },
  { id: 'passenger', name: 'Passenger Flow Analytics', subtitle: 'Terminal movement heatmaps' },
  { id: 'none', name: 'None / Custom', subtitle: 'I will define my own data' },
]

const THEMES = [
  { id: 'bial', name: 'Bangalore Airport Theme', subtitle: 'Official BIAL brand colors and typography' },
  { id: 'mobile', name: 'App Style (iOS/Android)', subtitle: 'Clean mobile-first material design' },
  { id: 'dashboard', name: 'Dashboard / Analytics', subtitle: 'Data-dense layout with charts and metrics' },
  { id: 'kiosk', name: 'Kiosk / Public Display', subtitle: 'Large text, high contrast, touch-friendly' },
]

const DEMO_PROMPT = `Build a Staff Cab and Carpool Sharing App for Bangalore Airport ground staff. The app should be called "RideLink BLR".

Users: Pre-load 8 dummy staff profiles across Ground Ops, Security, and Logistics departments, each with a name, staff ID (BIAL-XXXXX format), home zone (North Bangalore, South Bangalore, East Bangalore, Whitefield Corridor), and shift timing (Morning 6AM-2PM, Afternoon 2PM-10PM, Night 10PM-6AM).

Core Flow 1 – Request a Ride: A staff member selects their shift end time and home zone, then posts a ride request. The app matches them with other staff ending their shift within a 30-minute window heading to the same zone. Show matched riders in a card list with name, department, and pickup point (Terminal 2 Gate 4 or Terminal 1 Main Exit).

Core Flow 2 – Offer a Carpool: A staff member with their own vehicle can post an available carpool slot specifying their departure time, home zone, and number of seats (1-3). Other staff in the same zone and time window see the offer and can tap to join. Show a real-time seat counter that updates as people join.

Design: Use the Bangalore Airport theme with the BIAL teal and amber color palette. The layout should be mobile-first since staff will use this on their phones during shift changes. Include a simple dashboard showing today's active rides, upcoming matches, and a "My Rides" history tab.

Tech: React frontend with local state management. No backend needed – use mocked data for all dummy users and ride matching logic.`

const EXAMPLES = [
  {
    icon: LayoutGrid,
    color: 'text-primary',
    bg: 'bg-primary/10',
    title: 'Resource Management',
    desc: '"Build a system to track gate equipment maintenance logs and schedules."',
    prompt: 'Build a system to track gate equipment maintenance logs and schedules. Include a calendar view for upcoming maintenance, a status dashboard showing equipment health across all gates, and alert notifications when equipment is overdue for service.',
  },
  {
    icon: Users,
    color: 'text-secondary',
    bg: 'bg-secondary/10',
    title: 'Staff Coordination',
    desc: '"An app for roster updates and emergency broadcast notifications for T1 teams."',
    prompt: 'Create an app for roster updates and emergency broadcast notifications for Terminal 1 teams. Include a shift calendar, one-tap emergency broadcast to all on-duty staff, and a message board for shift handover notes.',
  },
  {
    icon: BarChart3,
    color: 'text-primary',
    bg: 'bg-primary/10',
    title: 'Flight Metrics',
    desc: '"Visual dashboard for tracking turn-around times by airline partner."',
    prompt: 'Create a visual dashboard for tracking turn-around times by airline partner. Show a comparison chart of target vs actual times, drill-down by gate number, and highlight delays exceeding 15 minutes with automatic escalation flags.',
  },
]

function SelectDropdown({ icon: Icon, options, value, onChange, placeholder }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const onOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onOutside); document.removeEventListener('keydown', onEsc) }
  }, [])

  const selected = options.find((o) => o.id === value)

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 text-xs font-worksans font-medium border rounded-lg px-3 py-2 transition whitespace-nowrap ${
          value ? 'bg-primary/5 border-primary text-primary' : 'bg-white border-bial-border text-neutral hover:border-primary hover:text-primary'
        }`}
      >
        <Icon size={12} />
        <span className="max-w-[120px] truncate">{selected ? selected.name : placeholder}</span>
        <ChevronDown size={11} className={`transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1.5 w-64 bg-white rounded-xl border border-bial-border shadow-xl z-50 py-1 overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => { onChange(opt.id); setOpen(false) }}
              className={`w-full text-left px-4 py-2.5 hover:bg-primary/5 transition flex flex-col gap-0.5 ${value === opt.id ? 'bg-primary/5' : ''}`}
            >
              <span className={`text-xs font-bold ${value === opt.id ? 'text-primary' : 'text-tertiary'}`}>{opt.name}</span>
              <span className="text-[10px] text-neutral">{opt.subtitle}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SandboxPage() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [dataSource, setDataSource] = useState(null)
  const [theme, setTheme] = useState('bial')
  const [hasSchema, setHasSchema] = useState(false)
  const textareaRef = useRef(null)

  const handleGenerate = () => {
    if (!prompt.trim()) return
    navigate('/workspace/builder', { state: { prompt, dataSource, theme, hasSchema } })
  }

  const fillPrompt = (text) => {
    setPrompt(text)
    setTimeout(() => {
      textareaRef.current?.focus()
      textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  return (
    <div className="min-h-screen bg-bial-bg font-manrope flex flex-col">
      <Navbar />

      <main className="flex-1 flex flex-col items-center px-6 py-14">
        <h1 className="text-4xl font-extrabold text-tertiary text-center mb-3">
          Build What You Need. No Code Required
        </h1>
        <p className="text-neutral text-center max-w-lg mb-10 leading-relaxed">
          Turn everyday operational ideas into working applications. Just describe what you need in plain English — the BLR Citizen Developer Suite handles the rest.
        </p>

        {/* Prompt card */}
        <div className="w-full max-w-2xl bg-white rounded-2xl border border-bial-border shadow-sm">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) handleGenerate() }}
            placeholder="Describe the app you want to build... (e.g. 'Create a dashboard to track terminal 2 ground staff assignments with real-time delay alerts')"
            rows={6}
            className="w-full p-5 text-sm text-tertiary placeholder:text-gray-300 resize-none focus:outline-none rounded-t-2xl font-manrope leading-relaxed"
          />

          {/* Controls row */}
          <div className="px-4 py-3 border-t border-bial-border space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <SelectDropdown
                icon={Database}
                options={DATA_SOURCES}
                value={dataSource}
                onChange={setDataSource}
                placeholder="Select Data Source"
              />

              {/* Schema toggle */}
              <button
                onClick={() => setHasSchema((s) => !s)}
                className={`flex items-center gap-2 text-xs font-worksans font-medium border rounded-lg px-3 py-2 transition flex-shrink-0 ${
                  hasSchema
                    ? 'bg-primary/5 border-primary text-primary'
                    : 'bg-white border-bial-border text-neutral hover:border-primary hover:text-primary'
                }`}
              >
                <div className={`w-8 h-4 rounded-full relative transition-colors duration-200 flex-shrink-0 ${hasSchema ? 'bg-primary' : 'bg-gray-200'}`}>
                  <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform duration-200 ${hasSchema ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                Backend Schema
              </button>

              <SelectDropdown
                icon={Palette}
                options={THEMES}
                value={theme}
                onChange={setTheme}
                placeholder="Select Theme"
              />

              <button
                onClick={handleGenerate}
                disabled={!prompt.trim()}
                className="ml-auto flex items-center gap-2 bg-secondary hover:bg-secondary-600 disabled:opacity-40 text-white font-bold text-sm px-5 py-2 rounded-xl transition shadow-sm shadow-secondary/30 flex-shrink-0"
              >
                Generate App <Sparkles size={13} />
              </button>
            </div>

            {hasSchema && (
              <p className="text-[10px] text-primary/80 pl-1">
                A data model will be generated based on your prompt and selected data source.
              </p>
            )}
          </div>
        </div>

        {/* Featured demo card */}
        <div className="w-full max-w-2xl mt-6">
          <button
            onClick={() => fillPrompt(DEMO_PROMPT)}
            className="w-full bg-white border-2 border-secondary/40 rounded-xl p-4 text-left hover:border-secondary hover:shadow-md transition group flex items-center gap-4"
          >
            <div className="w-10 h-10 rounded-xl bg-secondary/10 flex items-center justify-center flex-shrink-0">
              <Car size={18} className="text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[10px] font-bold uppercase tracking-wider text-secondary block mb-0.5">Featured Demo</span>
              <h3 className="text-sm font-bold text-tertiary group-hover:text-secondary transition">Staff Cab and Carpool App</h3>
              <p className="text-xs text-neutral truncate">RideLink BLR — ride matching for ground ops, security, and logistics staff</p>
            </div>
            <ChevronDown size={14} className="text-neutral -rotate-90 group-hover:text-secondary transition flex-shrink-0" />
          </button>
        </div>

        {/* Suggestion cards */}
        <div className="w-full max-w-2xl mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          {EXAMPLES.map(({ icon: Icon, color, bg, title, desc, prompt: cardPrompt }) => (
            <button
              key={title}
              onClick={() => fillPrompt(cardPrompt)}
              className="bg-white rounded-xl border border-bial-border p-4 text-left hover:border-primary hover:shadow-md hover:-translate-y-0.5 transition cursor-pointer group"
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
