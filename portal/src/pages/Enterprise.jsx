import { useState } from 'react'
import { ThumbsUp, GitFork, MessageSquare, Star, Plus, Filter } from 'lucide-react'
import Navbar from '../components/layout/Navbar'
import { enterpriseApps, departments } from '../data/mockData'

function AppCard({ app }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex flex-col gap-3 hover:shadow-md transition">
      <div className="flex items-start justify-between">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg ${app.iconColor}`}>
          <div className="w-5 h-5 rounded bg-current opacity-70" />
        </div>
        <span className="flex items-center gap-1 bg-accent-light text-accent text-xs font-bold px-2 py-0.5 rounded-full">
          <Star size={10} fill="currentColor" />
          {app.rating}
        </span>
      </div>

      <div>
        <h3 className="text-sm font-bold text-tertiary mb-1">{app.name}</h3>
        <p className="text-xs text-neutral leading-relaxed">{app.description}</p>
      </div>

      <div className="flex items-center gap-4 pt-1 border-t border-gray-50 mt-auto">
        <span className="flex items-center gap-1 text-xs text-neutral">
          <ThumbsUp size={11} />
          {app.likes}
        </span>
        <span className="flex items-center gap-1 text-xs text-neutral">
          <GitFork size={11} />
          {app.forks}
        </span>
        <button className="flex items-center gap-1 text-xs text-primary font-semibold ml-auto relative">
          <MessageSquare size={11} />
          COMMENTS
          {app.comments > 0 && (
            <span className="ml-1 w-4 h-4 rounded-full bg-primary text-white text-[9px] flex items-center justify-center font-bold">
              {app.comments}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}

export default function Enterprise() {
  const [activeDept, setActiveDept] = useState('All Departments')
  const [search, setSearch] = useState('')

  const filtered = enterpriseApps.filter((app) => {
    const matchDept = activeDept === 'All Departments' || app.department === activeDept
    const matchSearch = app.name.toLowerCase().includes(search.toLowerCase())
    return matchDept && matchSearch
  })

  return (
    <div className="min-h-screen bg-surface-muted font-manrope flex flex-col">
      <Navbar />

      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-extrabold text-tertiary mb-2">Enterprise Space</h1>
          <p className="text-neutral text-sm leading-relaxed max-w-2xl">
            Secure, IT-published applications optimized for Terminal 3 operations. All tools are verified for compliance and operational efficiency.
          </p>
        </div>

        {/* Filter bar */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-6 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2 flex-1">
            {departments.map((dept) => (
              <button
                key={dept}
                onClick={() => setActiveDept(dept)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
                  activeDept === dept
                    ? 'bg-primary text-white'
                    : 'border border-gray-200 text-neutral hover:border-primary hover:text-primary'
                }`}
              >
                {dept}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-1.5">
              <input
                type="text"
                placeholder="Filter by name..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="text-sm text-tertiary placeholder:text-gray-400 focus:outline-none w-36"
              />
            </div>
            <button className="p-2 border border-gray-200 rounded-lg text-neutral hover:border-primary hover:text-primary transition">
              <Filter size={15} />
            </button>
          </div>
        </div>

        {/* App grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      </main>

      {/* FAB */}
      <button className="fixed bottom-8 right-8 w-12 h-12 rounded-full bg-tertiary text-accent flex items-center justify-center shadow-xl hover:bg-opacity-90 transition">
        <Plus size={20} />
      </button>
    </div>
  )
}
