import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MessageSquare, Wrench, Search, Trash2, ArrowLeft, ChevronLeft, ChevronRight, Sparkles,
} from 'lucide-react'
import Navbar from '../components/layout/Navbar'
import { loadHistory, relativeTime, deleteConversation } from '../utils/chatHistory'
import { loadBuilds, deleteBuild } from '../utils/builderHistory'

const PAGE_SIZE = 8

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'chat', label: 'Chats' },
  { key: 'build', label: 'Builds' },
]

// Merge the two per-user local stores into one list, newest first. Each item is
// tagged with its kind so the row can route/badge correctly.
function loadAll() {
  const chats = loadHistory().map((c) => ({ ...c, kind: 'chat' }))
  const builds = loadBuilds().map((b) => ({ ...b, kind: 'build' }))
  return [...chats, ...builds].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
}

export default function ConversationsPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState(loadAll)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(0)

  // Re-read when returning to the tab (e.g. after opening a chat/build) so the
  // list and timestamps stay current. localStorage reads are synchronous.
  useEffect(() => {
    const refresh = () => setItems(loadAll())
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  // Reset to the first page whenever the search/filter narrows the list.
  useEffect(() => {
    setPage(0)
  }, [query, filter])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(
      (it) =>
        (filter === 'all' || it.kind === filter) &&
        (q === '' || (it.title || '').toLowerCase().includes(q)),
    )
  }, [items, query, filter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const openItem = (it) =>
    navigate(it.kind === 'build' ? `/workspace/builder/${it.id}` : `/workspace/chat/${it.id}`)

  const removeItem = (it, e) => {
    e.stopPropagation()
    if (it.kind === 'build') deleteBuild(it.id)
    else deleteConversation(it.id)
    setItems(loadAll())
  }

  return (
    <div className="min-h-screen font-manrope flex flex-col" style={{ background: 'linear-gradient(160deg, #ffffff 0%, #f0f9f9 100%)' }}>
      <Navbar />

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-10">
        <button
          onClick={() => navigate('/workspace')}
          className="flex items-center gap-1 text-sm text-neutral hover:text-primary transition mb-4"
        >
          <ArrowLeft size={15} /> Back to App Builder
        </button>

        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-extrabold text-tertiary">Conversations</h1>
            <p className="text-sm text-neutral mt-1">All your planning chats and app builds in one place.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => navigate('/workspace/chat/new')}
              className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-primary border border-primary/30 rounded-lg hover:bg-primary/5 transition"
            >
              <MessageSquare size={15} /> Plan with AI
            </button>
            <button
              onClick={() => navigate('/workspace/sandbox')}
              className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold bg-primary text-white rounded-lg hover:bg-primary-dark transition"
            >
              <Sparkles size={15} /> Build an App
            </button>
          </div>
        </div>

        {/* Search + type filter */}
        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-bial-border bg-white text-sm text-tertiary placeholder:text-neutral focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex gap-1 bg-surface-muted rounded-lg p-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition ${
                  filter === f.key ? 'bg-white text-primary shadow-sm' : 'text-neutral hover:text-tertiary'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        {filtered.length === 0 ? (
          <div className="bg-white border border-bial-border rounded-2xl py-16 px-6 text-center">
            <Sparkles size={26} className="mx-auto text-primary/50 mb-3" />
            <p className="text-sm font-semibold text-tertiary">
              {items.length === 0 ? 'No conversations yet' : 'No matches'}
            </p>
            <p className="text-xs text-neutral mt-1">
              {items.length === 0
                ? 'Plan an app with AI or start a build, and it will show up here.'
                : 'Try a different search or filter.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {pageItems.map((it) => (
              <div
                key={it.kind + it.id}
                onClick={() => openItem(it)}
                className="group flex items-center gap-3 bg-white border border-bial-border rounded-xl px-4 py-3 cursor-pointer hover:border-primary/40 hover:shadow-sm transition"
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    it.kind === 'build' ? 'bg-secondary/10' : 'bg-primary/10'
                  }`}
                >
                  {it.kind === 'build' ? (
                    <Wrench size={15} className="text-secondary" />
                  ) : (
                    <MessageSquare size={15} className="text-primary" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-tertiary truncate">{it.title || 'Untitled'}</p>
                  <p className="text-xs text-neutral">{relativeTime(it.updatedAt)}</p>
                </div>
                <span
                  className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                    it.kind === 'build' ? 'bg-secondary/10 text-secondary' : 'bg-primary/10 text-primary'
                  }`}
                >
                  {it.kind === 'build' ? 'Build' : 'Chat'}
                </span>
                <button
                  onClick={(e) => removeItem(it, e)}
                  title="Delete"
                  aria-label={`Delete ${it.title || 'conversation'}`}
                  className="opacity-0 group-hover:opacity-100 text-neutral hover:text-danger p-1 transition"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-6">
            <p className="text-xs text-neutral">
              {filtered.length} conversation{filtered.length === 1 ? '' : 's'} · page {safePage + 1} of {totalPages}
            </p>
            <div className="flex gap-2">
              <button
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
                className="p-2 rounded-lg border border-bial-border text-neutral hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed transition"
                aria-label="Previous page"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage(safePage + 1)}
                className="p-2 rounded-lg border border-bial-border text-neutral hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed transition"
                aria-label="Next page"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
