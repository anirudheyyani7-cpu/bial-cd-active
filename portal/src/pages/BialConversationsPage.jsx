import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, MessageSquare, Search, Trash2, ArrowLeft, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import Navbar from '../components/layout/Navbar'
import { loadHistory, relativeTime, deleteConversation } from '../utils/assistantHistory'

const PAGE_SIZE = 8

// BIAL Chat "View all": title search + pagination over the assistant store only
// (no builds, so no Chats/Builds filter — single type). Mirrors ConversationsPage
// but reads bial_assistant_history and routes to /chat (Decision 8).
export default function BialConversationsPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState(() => loadHistory().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)))
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const refresh = () => setItems(loadHistory().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)))

  // Re-read when returning to the tab (e.g. after opening a chat) so the list
  // and timestamps stay current. localStorage reads are synchronous.
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  // Reset to the first page whenever the search narrows the list.
  useEffect(() => {
    setPage(0)
  }, [query])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((it) => q === '' || (it.title || '').toLowerCase().includes(q))
  }, [items, query])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const openItem = (it) => navigate(`/chat/${it.id}`)

  const removeItem = (it, e) => {
    e.stopPropagation()
    deleteConversation(it.id)
    refresh()
  }

  return (
    <div className="min-h-screen font-manrope flex flex-col" style={{ background: 'linear-gradient(160deg, #ffffff 0%, #f0f9f9 100%)' }}>
      <Navbar />

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-10">
        <button
          onClick={() => navigate('/chat')}
          className="flex items-center gap-1 text-sm text-neutral hover:text-primary transition mb-4"
        >
          <ArrowLeft size={15} /> Back to BIAL Chat
        </button>

        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-extrabold text-tertiary">BIAL Chat History</h1>
            <p className="text-sm text-neutral mt-1">All your conversations with BIAL Chat in one place.</p>
          </div>
          <button
            onClick={() => navigate('/chat')}
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold bg-primary text-white rounded-lg hover:bg-primary-dark transition"
          >
            <Plus size={15} /> New chat
          </button>
        </div>

        {/* Search */}
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
        </div>

        {/* List */}
        {filtered.length === 0 ? (
          <div className="bg-white border border-bial-border rounded-2xl py-16 px-6 text-center">
            <Bot size={26} className="mx-auto text-primary/50 mb-3" />
            <p className="text-sm font-semibold text-tertiary">
              {items.length === 0 ? 'No conversations yet' : 'No matches'}
            </p>
            <p className="text-xs text-neutral mt-1">
              {items.length === 0
                ? 'Start a conversation in BIAL Chat and it will show up here.'
                : 'Try a different search.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {pageItems.map((it) => (
              <div
                key={it.id}
                onClick={() => openItem(it)}
                className="group flex items-center gap-3 bg-white border border-bial-border rounded-xl px-4 py-3 cursor-pointer hover:border-primary/40 hover:shadow-sm transition"
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-primary/10">
                  <MessageSquare size={15} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-tertiary truncate">{it.title || 'Untitled'}</p>
                  <p className="text-xs text-neutral">{relativeTime(it.updatedAt)}</p>
                </div>
                <button
                  onClick={(e) => removeItem(it, e)}
                  title="Delete"
                  aria-label={`Delete ${it.title || 'conversation'}`}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-neutral hover:text-danger p-1 transition"
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
