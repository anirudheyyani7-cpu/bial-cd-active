import { useState } from 'react'
import { ChevronDown, CheckCircle, XCircle } from 'lucide-react'
import Navbar from '../components/layout/Navbar'

const EXAMPLE_PROMPTS = [
  {
    level: 'Simple',
    color: 'bg-green-100 text-green-700',
    text: 'Build a shift handover checklist for Ground Ops supervisors. Include checkboxes for each task, a notes field, and a timestamp when the handover is signed off.',
  },
  {
    level: 'Intermediate',
    color: 'bg-blue-100 text-blue-700',
    text: 'Create a gate assignment dashboard that shows all Terminal 2 gates on a map layout. Color-code gates by status: green for available, amber for scheduled, red for delayed. Pull data from AODB and auto-refresh every 60 seconds.',
  },
  {
    level: 'Advanced',
    color: 'bg-purple-100 text-purple-700',
    text: 'Build a predictive delay alert system for Terminal 3 operations. Use flight schedule data from FIDS and historical delay patterns to flag flights likely to experience delays exceeding 20 minutes. Show a priority-ranked list with estimated delay duration, affected gate, and suggested resource reallocation. Include a one-tap escalation button that notifies the shift supervisor.',
  },
  {
    level: 'Full-stack',
    color: 'bg-amber-100 text-amber-700',
    text: 'Create a staff cab and carpool sharing app called RideLink BLR. Include dummy user profiles across 3 departments, a ride request flow with shift-time matching, a carpool offer flow with seat management, and a mobile-first dashboard. Use Bangalore Airport theme.',
  },
]

const DOS = [
  'Name the specific terminal, gate, or zone',
  'Mention the data source (AODB, BHS, etc.)',
  'Describe 3–5 key features explicitly',
  'Specify the user type (ground ops, control room, passenger-facing)',
  'Mention layout preference (mobile-first, dashboard, kiosk)',
  'Iterate with the AI chat after generation — ask for specific changes',
]

const DONTS = [
  'Say "make an app for the airport" with no specifics',
  'Assume the AI knows which system to connect to',
  'Write a single vague sentence',
  'Leave out who the app is for',
  'Expect the AI to guess the right layout',
  'Expect a perfect app on the first prompt',
]

const FAQS = [
  {
    q: 'What is the BIAL Citizen Developer portal?',
    a: 'It is an internal platform that empowers Bangalore International Airport staff to build custom operational tools and digital solutions without writing code. You describe what you need in plain English, and the AI generates a working application that can be deployed to the terminal operations dashboard.',
  },
  {
    q: 'Who can use this portal?',
    a: 'Any BIAL staff member with a valid Staff ID (BIAL-XXXXX) can log in and start building apps. No programming experience is required.',
  },
  {
    q: 'What happens when I click "Generate App"?',
    a: 'The AI analyzes your prompt, creates a wireframe layout, generates the application code, and renders a live preview. This typically takes 10–15 seconds. You can then refine the app using the chat interface.',
  },
  {
    q: 'Can I edit the app after it is generated?',
    a: 'Yes. The chat panel on the left side of the builder lets you request changes in plain English. You can ask to change colors, add tables, remove sections, switch to mobile layout, and more.',
  },
  {
    q: 'What does "Deploy" do?',
    a: 'Deploying pushes your app to the terminal operations dashboard where other staff can access it. You choose whether to keep it private, share with your team, or submit it for enterprise-wide publishing (which requires IT review).',
  },
  {
    q: 'Can I see the actual code behind my app?',
    a: 'Yes. Click the "View Code" button in the builder toolbar to see the generated React code. However, you do not need to understand or edit the code — the AI chat handles all changes.',
  },
  {
    q: 'What data sources are available?',
    a: 'The portal connects to AODB (Airport Operations Database), Vision Analytics System, Flight Information Display System (FIDS), Baggage Handling System telemetry, Staff Roster database, and Passenger Flow Analytics. You can select your data source from the dropdown on the Sandbox page.',
  },
  {
    q: 'Is there a limit to how many apps I can build?',
    a: 'There is no hard limit during the current phase. Build as many prototypes as you need. Deployed apps are subject to IT resource allocation policies.',
  },
  {
    q: 'Who do I contact for help?',
    a: 'Reach out to the IT Support Desk via the portal footer link, or email citizen-developer-support@bfrport.com.',
  },
]

function AccordionItem({ question, answer }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-bial-border last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between py-4 text-left gap-4 hover:text-primary transition"
      >
        <span className="text-sm font-semibold text-tertiary">{question}</span>
        <ChevronDown size={16} className={`text-neutral flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="pb-4 pr-6">
          <p className="text-sm text-neutral leading-relaxed">{answer}</p>
        </div>
      )}
    </div>
  )
}

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-bial-bg font-manrope flex flex-col">
      <Navbar />

      <main className="flex-1 px-6 py-10">
        <div className="max-w-3xl mx-auto space-y-8">
          {/* Header */}
          <div>
            <h1 className="text-3xl font-extrabold text-tertiary mb-2">Help Center</h1>
            <p className="text-neutral leading-relaxed">
              Everything you need to know about building, deploying, and managing apps on the BIAL Citizen Developer portal.
            </p>
          </div>

          {/* Quick Start */}
          <div className="bg-primary rounded-2xl p-6 text-white">
            <h2 className="text-lg font-bold mb-1">New here? Start with the basics</h2>
            <p className="text-white/70 text-sm mb-5">Three steps to your first operational app.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { n: '1', title: 'Describe your app', body: 'Write a plain English prompt in the Sandbox describing what tool you need.' },
                { n: '2', title: 'Refine with AI', body: 'Our AI assistant will generate the app. Use the chat to adjust layout, data, and features.' },
                { n: '3', title: 'Deploy to Terminal', body: 'Push your app live to the terminal operations dashboard with one click.' },
              ].map(({ n, title, body }) => (
                <div key={n} className="bg-white/10 rounded-xl p-4">
                  <div className="w-6 h-6 rounded-full bg-white/20 text-white text-xs font-bold flex items-center justify-center mb-3">{n}</div>
                  <p className="text-sm font-bold mb-1">{title}</p>
                  <p className="text-xs text-white/75 leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Prompt Engineering Guide */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="text-lg font-bold text-tertiary mb-5">Writing Effective Prompts</h2>

            <div className="space-y-6">
              {/* What makes a good prompt */}
              <div>
                <h3 className="text-sm font-bold text-tertiary mb-3">What makes a good prompt?</h3>
                <div className="space-y-3">
                  {[
                    { title: 'Be specific about the problem', body: 'Instead of "Build a tracking app", say "Build a real-time baggage carousel status tracker for Terminal 3, showing load percentage, motor temperature, and maintenance alerts for belts 12A through 24C."' },
                    { title: 'Name your data source', body: 'Mention which airport system your app should pull from — AODB, Vision Analytics, BHS Telemetry, Staff Roster, or FIDS. If you are unsure, select it from the Data Source dropdown.' },
                    { title: 'Describe the users', body: 'Who will use this app? Ground ops staff on mobile during shifts? Control room operators on desktop dashboards? Knowing the user shapes the layout.' },
                    { title: 'Specify key features', body: 'List the 3–5 most important features. For example: "Include a calendar view, a status dashboard, alert notifications, and a CSV export button."' },
                    { title: 'Set design expectations', body: 'Mention if you want mobile-first, dashboard-style, kiosk-friendly, or standard desktop layout. Selecting a Theme from the dropdown also helps.' },
                  ].map(({ title, body }) => (
                    <div key={title} className="flex gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                      <div>
                        <span className="text-sm font-semibold text-tertiary">{title}: </span>
                        <span className="text-sm text-neutral">{body}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Example prompts */}
              <div>
                <h3 className="text-sm font-bold text-tertiary mb-3">Example Prompts</h3>
                <div className="space-y-3">
                  {EXAMPLE_PROMPTS.map(({ level, color, text }) => (
                    <div key={level} className="border border-bial-border rounded-xl p-4">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${color} inline-block mb-2`}>{level}</span>
                      <p className="text-sm text-neutral leading-relaxed italic">"{text}"</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Do / Don't */}
              <div>
                <h3 className="text-sm font-bold text-tertiary mb-3">Prompt Dos and Don'ts</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-green-50 border border-green-100 rounded-xl p-4">
                    <p className="text-xs font-bold text-green-700 uppercase tracking-wider mb-3">Do</p>
                    <div className="space-y-2">
                      {DOS.map((item) => (
                        <div key={item} className="flex items-start gap-2">
                          <CheckCircle size={13} className="text-green-500 flex-shrink-0 mt-0.5" />
                          <span className="text-xs text-green-800 leading-relaxed">{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="bg-red-50 border border-red-100 rounded-xl p-4">
                    <p className="text-xs font-bold text-red-600 uppercase tracking-wider mb-3">Don't</p>
                    <div className="space-y-2">
                      {DONTS.map((item) => (
                        <div key={item} className="flex items-start gap-2">
                          <XCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
                          <span className="text-xs text-red-700 leading-relaxed">{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* FAQ */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="text-lg font-bold text-tertiary mb-2">Frequently Asked Questions</h2>
            <div className="mt-4">
              {FAQS.map(({ q, a }) => (
                <AccordionItem key={q} question={q} answer={a} />
              ))}
            </div>
          </div>

          {/* Deployment Strategy */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="text-lg font-bold text-tertiary mb-4">Understanding Deployment</h2>
            <div className="space-y-4">
              {[
                {
                  title: 'Workspace deployment',
                  color: 'bg-gray-100 text-gray-600',
                  body: 'Keeps your app private. Only you can access it from your My Workspace page. Use this for prototyping, testing ideas, and iterating on prompts before sharing.',
                },
                {
                  title: 'Team deployment',
                  color: 'bg-primary/10 text-primary',
                  body: 'Shares the app with your department\'s Team Space. All team members can access and use the app. The app creator retains edit permissions. This is ideal for department-specific tools like shift handover checklists or equipment trackers.',
                },
                {
                  title: 'Enterprise deployment',
                  color: 'bg-secondary/10 text-secondary',
                  body: 'Submits the app for IT review. Once approved, the app becomes available in the Enterprise Space where all terminal staff can access it. Enterprise apps must meet compliance and security standards. The typical review cycle is 2–3 business days.',
                },
              ].map(({ title, color, body }) => (
                <div key={title} className="flex gap-4">
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0 h-fit mt-0.5 ${color}`}>{title}</span>
                  <p className="text-sm text-neutral leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Footer note */}
          <div className="text-center pb-8">
            <p className="text-sm text-neutral">
              Still need help?{' '}
              <a href="mailto:citizen-developer-support@bfrport.com" className="text-primary font-semibold hover:underline">
                Contact IT Support Desk
              </a>
            </p>
            <p className="text-xs text-neutral/50 mt-1">Last updated: April 2026</p>
          </div>
        </div>
      </main>
    </div>
  )
}
