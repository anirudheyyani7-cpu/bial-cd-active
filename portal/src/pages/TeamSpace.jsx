import { useState, useEffect } from 'react'
import { Plus, Zap, MapPin, ExternalLink, Grid, Users, RefreshCw, MessageSquare, Sparkles, X } from 'lucide-react'
import Navbar from '../components/layout/Navbar'
import { teamStats, teamDiscussions } from '../data/mockData'

const STAT_ICONS = { Grid, Users, RefreshCw }

function StatCard({ stat }) {
  const Icon = STAT_ICONS[stat.icon]
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-center gap-4">
      <div className="w-10 h-10 rounded-xl bg-surface-muted flex items-center justify-center">
        {Icon && <Icon size={17} className="text-neutral" />}
      </div>
      <div>
        <p className="text-[10px] font-worksans font-semibold tracking-widest uppercase text-neutral mb-0.5">
          {stat.label}
        </p>
        <p className="text-2xl font-extrabold text-tertiary">{stat.value}</p>
      </div>
    </div>
  )
}

export default function TeamSpace() {
  const [showFABTooltip, setShowFABTooltip] = useState(false)

  return (
    <div className="min-h-screen bg-surface-muted font-manrope flex flex-col">
      <Navbar />

      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-xs font-worksans font-semibold tracking-widest uppercase text-primary bg-primary/10 px-3 py-1 rounded-full">
                Ground Operations
              </span>
              <span className="text-xs text-neutral">12 Active Members</span>
            </div>
            <h1 className="text-3xl font-extrabold text-tertiary mb-1">My Team Space</h1>
            <p className="text-neutral text-sm">Collaborative workspace for terminal logistics and staff services.</p>
          </div>
          <button className="flex items-center gap-2 bg-primary text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-primary-dark transition shadow-sm">
            <Plus size={14} />
            New Team App
          </button>
        </div>

        {/* Featured apps row */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 mb-6">
          {/* Card 1 — Cab Booking (large) */}
          <div className="lg:col-span-3 bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden flex flex-col sm:flex-row">
            {/* Illustration side */}
            <div className="w-full sm:w-48 bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center p-6 flex-shrink-0">
              <div className="w-24 h-24 rounded-full bg-primary/20 flex items-center justify-center">
                <div className="w-14 h-14 rounded-full bg-primary/30 flex items-center justify-center">
                  <Users size={28} className="text-primary" />
                </div>
              </div>
            </div>

            {/* Content side */}
            <div className="p-5 flex flex-col flex-1">
              <div className="flex items-start justify-between mb-3">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Zap size={16} className="text-primary" />
                </div>
                <span className="text-xs border border-gray-200 text-neutral px-2 py-0.5 rounded-full font-medium">
                  Internal Tool
                </span>
              </div>
              <h2 className="text-base font-bold text-tertiary mb-1">Cab Booking for Staff</h2>
              <p className="text-xs text-neutral leading-relaxed mb-3 flex-1">
                Automated booking system for late-night shift staff transit and terminal transfers.
              </p>
              <div className="flex flex-wrap gap-2 mb-4">
                <span className="flex items-center gap-1 text-xs bg-primary/10 text-primary px-2.5 py-1 rounded-full font-medium">
                  <Zap size={10} />
                  Auto-Approval
                </span>
                <span className="flex items-center gap-1 text-xs bg-primary/10 text-primary px-2.5 py-1 rounded-full font-medium">
                  <MapPin size={10} />
                  GPS Tracked
                </span>
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-gray-50">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-[10px] text-white font-bold">
                    AK
                  </div>
                  <div>
                    <p className="text-[10px] text-neutral">Last updated by Arjun K.</p>
                    <p className="text-[10px] text-neutral">Shared with 12 team members</p>
                  </div>
                </div>
                <button className="flex items-center gap-1 text-xs text-primary font-semibold hover:underline">
                  Open App <ExternalLink size={11} />
                </button>
              </div>
            </div>
          </div>

          {/* Card 2 — Visiting Card (secondary) */}
          <div className="lg:col-span-2 bg-white rounded-xl border-l-4 border-l-accent border border-gray-100 shadow-sm p-5 flex flex-col">
            <div className="flex items-start justify-between mb-3">
              <div className="w-9 h-9 rounded-lg bg-accent-light flex items-center justify-center">
                <Grid size={16} className="text-accent" />
              </div>
              <div className="flex -space-x-2">
                {['PS', 'AK', 'MR'].map((init) => (
                  <div key={init} className="w-6 h-6 rounded-full bg-primary/10 border border-white flex items-center justify-center text-[9px] font-bold text-primary">
                    {init}
                  </div>
                ))}
                <div className="w-6 h-6 rounded-full bg-surface-muted border border-white flex items-center justify-center text-[9px] font-semibold text-neutral">
                  +10
                </div>
              </div>
            </div>

            <h2 className="text-base font-bold text-tertiary mb-1">Duplicate Visiting Card Request</h2>
            <p className="text-xs text-neutral leading-relaxed mb-4 flex-1">
              Request replacements for lost or damaged staff credentials and business cards.
            </p>

            {/* Progress bars */}
            <div className="space-y-3 mb-4">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] text-neutral">Processing Time</span>
                  <span className="text-[10px] font-semibold text-neutral">24-48 Hours</span>
                </div>
                <div className="h-1.5 bg-surface-muted rounded-full">
                  <div className="h-full w-2/3 bg-accent rounded-full" />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] text-neutral">Form Completion</span>
                  <span className="text-[10px] font-semibold text-success">75% Ready</span>
                </div>
                <div className="h-1.5 bg-surface-muted rounded-full">
                  <div className="h-full w-3/4 bg-success rounded-full" />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-gray-50">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-gray-900 flex items-center justify-center text-[10px] text-white font-bold">
                  PS
                </div>
                <p className="text-[10px] text-neutral">Last updated by Priya S.</p>
              </div>
              <button className="text-xs border border-accent text-accent font-semibold px-3 py-1 rounded-lg hover:bg-accent-light transition">
                Edit Workflow
              </button>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {teamStats.map((stat) => (
            <StatCard key={stat.label} stat={stat} />
          ))}
        </div>

        {/* Recent discussions */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <MessageSquare size={16} className="text-primary" />
              <div>
                <h2 className="text-sm font-bold text-tertiary">Recent Team Discussions</h2>
                <p className="text-xs text-neutral">Project-level communications and task updates</p>
              </div>
            </div>
            <button className="text-xs text-primary font-semibold hover:underline">View All Activity</button>
          </div>

          <div className="space-y-3">
            {teamDiscussions.map((d) => (
              <div key={d.id} className="flex items-start gap-3 py-3 border-t border-gray-50">
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-xs text-white font-bold flex-shrink-0">
                  {d.initials}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-semibold text-tertiary">{d.user}</span>
                    <span className="text-[10px] text-neutral">App: {d.app}</span>
                  </div>
                  <p className="text-xs text-neutral truncate">{d.preview}</p>
                </div>
                <span className="text-[10px] text-neutral whitespace-nowrap flex-shrink-0">{d.timestamp}</span>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* FAB */}
      <button className="fixed bottom-8 right-8 w-12 h-12 rounded-full bg-primary text-white flex items-center justify-center shadow-xl hover:bg-primary-dark transition">
        <Sparkles size={18} />
      </button>
    </div>
  )
}
