import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { Sparkles, User, Send, Plus, MessageSquare, Trash2, Hammer, Paperclip, X, FileText, FileSpreadsheet } from 'lucide-react'
import Navbar from '../components/layout/Navbar'
import MessageContent from '../components/chat/MessageContent'
import AttachmentLightbox from '../components/AttachmentLightbox'
import { useClaudeAPI, CONTEXT_SOFT_LIMIT, CONTEXT_HARD_LIMIT, estimateConversationTokens } from '../hooks/useClaudeAPI'
import { usePendingAttachments } from '../hooks/usePendingAttachments'
import {
  loadHistory,
  newConversation,
  appendMessage,
  getConversation,
  deleteConversation,
  buildPromptFromHistory,
  relativeTime,
} from '../utils/chatHistory'
import { assembleApiMessages, putAttachment, countAttachments } from '../utils/attachmentStore'
import { ACCEPT_ATTR, toAttachmentRef, validateConversationAttachmentCap, TEXT_MEDIA_TYPES } from '../utils/attachmentInput'
import { openPdf } from '../utils/attachmentViewer'

const PLANNING_SYSTEM_PROMPT = `You are Citizen Developer AI, a planning assistant for the Bengaluru International Airport (BIAL) Citizen Developer Portal.

Your role in this mode is to help airport staff plan and define their app requirements through conversation — NOT to generate code yet.

Guidelines:
- Ask clarifying questions to understand the user's operational need
- Help them articulate what their app should do, who will use it, and what data it needs
- Suggest features based on airport operations context (flight tracking, staff rostering, baggage, gate management, etc.)
- Keep responses concise and practical — staff are busy
- If the user attaches images (screenshots, mockups, photos) or PDFs (specs, sample data), examine them and use what they actually show to inform the plan — you can see attachments, so refer to their real content
- When you feel the requirements are well-defined, summarise the plan and suggest moving to the builder

Do not output code or JSX. Stay focused on requirements gathering and planning.`

export default function ChatPage() {
  const navigate = useNavigate()
  const { chatId } = useParams()
  const location = useLocation()

  const [history, setHistory] = useState([])
  const [activeChatId, setActiveChatId] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)
  const [showBuildModal, setShowBuildModal] = useState(false)
  const [viewer, setViewer] = useState(null) // { name, src } for the pending-attachment lightbox
  const buildSuggestionFiredRef = useRef(false)

  const { sendMessage, error } = useClaudeAPI()
  const { pendingAttachments, handleFileSelect, removePending, clearPending, attachToast, showAttachToast } =
    usePendingAttachments()
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // Running context-length estimate → 'ok' | 'warn' | 'full'. Drives the
  // guardrail banner + send-disable below. Recomputed each render (cheap).
  const ctxTokens = estimateConversationTokens(messages, PLANNING_SYSTEM_PROMPT)
  const ctxLevel = ctxTokens >= CONTEXT_HARD_LIMIT ? 'full' : ctxTokens >= CONTEXT_SOFT_LIMIT ? 'warn' : 'ok'

  const refreshHistory = useCallback(() => {
    setHistory(loadHistory().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)))
  }, [])

  // Load sidebar history on mount and when activeChatId changes
  useEffect(() => {
    refreshHistory()
  }, [refreshHistory, activeChatId])

  // Handle route param and initial message from SandboxPage
  useEffect(() => {
    if (chatId === 'new') {
      const initialMessage = location.state?.initialMessage
      if (initialMessage) {
        const id = newConversation(initialMessage)
        setActiveChatId(id)
        navigate(`/workspace/chat/${id}`, { replace: true, state: { initialMessage } })
      } else {
        // New chat with no initial message — just show empty state
        setActiveChatId(null)
        setMessages([])
      }
    } else if (chatId) {
      const conv = getConversation(chatId)
      if (conv) {
        setActiveChatId(chatId)
        setMessages(
          conv.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }))
        )
        buildSuggestionFiredRef.current = false
      } else {
        navigate('/workspace/chat/new', { replace: true })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  // Fire initial message once activeChatId is set from 'new' flow
  useEffect(() => {
    if (!activeChatId) return
    const initialMessage = location.state?.initialMessage
    if (initialMessage && messages.length === 0) {
      fireMessage(initialMessage)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, generating])

  const persistMessage = useCallback((chatId, msg) => {
    appendMessage(chatId, {
      id: msg.id,
      role: msg.role,
      content: msg.content, // plain text only — attachment bytes never enter localStorage
      ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp,
    })
  }, [])

  const fireMessage = useCallback(async (rawText, attachments = [], explicitChatId) => {
    if (generating) return
    const text = rawText.trim() || (attachments.length ? 'Please review the attached file(s).' : '')
    if (!text && attachments.length === 0) return
    // A brand-new chat passes its id explicitly: setActiveChatId hasn't committed
    // yet when handleSend schedules this, so the activeChatId closure is stale.
    const currentChatId = explicitChatId ?? activeChatId

    // Persist attachment BYTES to IndexedDB (never localStorage); the message
    // keeps only lightweight refs. A cap/storage error aborts the send.
    let refs = []
    if (attachments.length > 0) {
      try {
        for (const a of attachments) {
          await putAttachment({ id: a.id, base64: a.base64, mediaType: a.mediaType, size: a.size })
        }
        refs = attachments.map(toAttachmentRef)
      } catch (err) {
        showAttachToast(err?.message || 'Could not store the attachment.')
        return
      }
    }

    const userMsg = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: text,
      ...(refs.length ? { attachments: refs } : {}),
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMsg])
    persistMessage(currentChatId, userMsg)
    setGenerating(true)

    // Assemble the API messages: a turn with attachment refs becomes a
    // ContentBlock[] (files before text, bytes re-read from the store); a plain
    // turn stays a string. The server forwards the blocks untouched.
    const apiMessages = await assembleApiMessages([...messagesRef.current, userMsg])

    const assistantId = `msg_${Date.now()}_a`
    let assistantText = ''

    setMessages((prev) => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    }])

    const result = await sendMessage(
      apiMessages,
      (delta) => {
        assistantText += delta
        setMessages((prev) =>
          prev.map((m) => m.id === assistantId ? { ...m, content: assistantText } : m)
        )
      },
      { systemPrompt: PLANNING_SYSTEM_PROMPT }
    )

    setGenerating(false)

    // A falsy result means the send failed (429/network), was aborted, OR
    // streamed zero text. Drop the optimistic empty assistant bubble so it isn't
    // persisted as content:'' (which the API rejects on the next turn) and isn't
    // left blank on screen. Any error message surfaces via the `error` banner.
    if (!result) {
      setMessages((prev) => prev.filter((m) => m.id !== assistantId))
      return
    }

    refreshHistory()

    const finalMsg = {
      id: assistantId,
      role: 'assistant',
      content: assistantText,
      timestamp: new Date(),
    }
    persistMessage(currentChatId, finalMsg)

    // Check if we should suggest moving to builder
    const allMessages = [...messagesRef.current]
    const shouldSuggest =
      !buildSuggestionFiredRef.current &&
      allMessages.filter((m) => m.role === 'user').length >= 3 &&
      (
        allMessages.length >= 6 ||
        /ready to build|shall we proceed|want me to create|build this for you|sounds like a plan/i.test(assistantText)
      )

    if (shouldSuggest) {
      buildSuggestionFiredRef.current = true
      setTimeout(() => setShowBuildModal(true), 600)
    }
  }, [activeChatId, generating, sendMessage, persistMessage, refreshHistory, showAttachToast])

  const handleSend = () => {
    const text = input.trim()
    const attachments = pendingAttachments
    if (!text && attachments.length === 0) return

    // Guardrails run BEFORE clearing the composer so an aborted send keeps the
    // user's draft + pending files. Context full → hard stop (send is also
    // disabled in the UI). Per-conversation attachment cap → distinct toast.
    if (ctxLevel === 'full') return
    if (attachments.length > 0) {
      const cap = validateConversationAttachmentCap(countAttachments(messages), attachments.length)
      if (cap.error) {
        showAttachToast(cap.error)
        return
      }
    }

    setInput('')
    clearPending()

    if (!activeChatId) {
      const id = newConversation(text || 'Attachment')
      setActiveChatId(id)
      navigate(`/workspace/chat/${id}`, { replace: true })
      // Pass the new id explicitly — the activeChatId state hasn't committed yet,
      // so fireMessage's closure would otherwise persist against a null chat id.
      setTimeout(() => fireMessage(text, attachments, id), 0)
    } else {
      fireMessage(text, attachments)
    }
  }

  const handleSelectChat = (id) => {
    setViewer(null)
    navigate(`/workspace/chat/${id}`)
    buildSuggestionFiredRef.current = false
  }

  const handleNewChat = () => {
    setViewer(null)
    setMessages([])
    setActiveChatId(null)
    buildSuggestionFiredRef.current = false
    navigate('/workspace/chat/new', { replace: true, state: {} })
  }

  const handleDeleteChat = (e, id) => {
    e.stopPropagation()
    deleteConversation(id)
    refreshHistory()
    if (activeChatId === id) {
      setMessages([])
      setActiveChatId(null)
      navigate('/workspace/chat/new', { replace: true, state: {} })
    }
  }

  const handleBuildApp = () => {
    const prompt = buildPromptFromHistory(messages)
    navigate('/workspace/builder', {
      state: { prompt, dataSource: 'none', theme: 'bial', hasSchema: false, uploadedFiles: [] },
    })
  }

  return (
    <div className="h-screen overflow-hidden bg-bial-bg font-manrope flex flex-col">
      <Navbar />

      <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 56px)' }}>
        {/* Sidebar */}
        <aside className="w-64 flex-shrink-0 bg-white border-r border-bial-border flex flex-col overflow-hidden">
          <div className="p-3 border-b border-bial-border">
            <button
              onClick={handleNewChat}
              className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-dark text-white text-sm font-bold rounded-xl px-4 py-2.5 transition"
            >
              <Plus size={15} />
              New Chat
            </button>
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-thin py-2">
            {history.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <MessageSquare size={28} className="text-bial-border mx-auto mb-2" />
                <p className="text-xs text-neutral">No conversations yet</p>
              </div>
            ) : (
              history.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => handleSelectChat(conv.id)}
                  className={`group relative mx-2 my-0.5 rounded-xl px-3 py-2.5 cursor-pointer transition flex flex-col gap-0.5 ${
                    conv.id === activeChatId
                      ? 'bg-bial-bg border-l-2 border-primary'
                      : 'hover:bg-surface-muted border-l-2 border-transparent'
                  }`}
                >
                  <p className={`text-xs font-semibold truncate pr-6 ${conv.id === activeChatId ? 'text-primary' : 'text-tertiary'}`}>
                    {conv.title}
                  </p>
                  <p className="text-[10px] text-neutral">{relativeTime(conv.updatedAt)}</p>
                  <button
                    onClick={(e) => handleDeleteChat(e, conv.id)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-neutral hover:text-danger transition p-1"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Chat area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Chat toolbar */}
          <div className="bg-white border-b border-bial-border px-5 py-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                  <Sparkles size={14} className="text-white" />
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-400 rounded-full border-2 border-white" />
              </div>
              <div>
                <p className="text-sm font-bold text-tertiary">Citizen Developer AI</p>
                <p className="text-[10px] text-neutral">Planning mode · powered by Anthropic</p>
              </div>
            </div>
            {messages.length > 0 && (
              <button
                onClick={() => setShowBuildModal(true)}
                className="flex items-center gap-2 bg-secondary hover:bg-secondary-600 text-white text-xs font-bold px-4 py-2 rounded-xl transition shadow-sm shadow-secondary/30"
              >
                <Hammer size={12} />
                Build This App
              </button>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 scrollbar-thin">
            {messages.length === 0 && !generating && (
              <div className="h-full flex flex-col items-center justify-center text-center pb-8">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                  <Sparkles size={28} className="text-primary" />
                </div>
                <h2 className="text-lg font-bold text-tertiary mb-2">Plan your next app</h2>
                <p className="text-sm text-neutral max-w-sm leading-relaxed">
                  Describe what you need in plain English. I'll help you think it through before you build.
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                  msg.role === 'assistant' ? 'bg-primary/10' : 'bg-secondary/10'
                }`}>
                  {msg.role === 'assistant'
                    ? <Sparkles size={10} className="text-primary" />
                    : <User size={10} className="text-secondary" />
                  }
                </div>
                <div className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-tertiary text-white rounded-tr-sm'
                    : 'bg-white border border-bial-border text-tertiary rounded-tl-sm'
                }`}>
                  <MessageContent content={msg.content} attachments={msg.attachments} isUser={msg.role === 'user'} />
                  <p className="text-[10px] mt-1.5 opacity-40">
                    {msg.timestamp instanceof Date
                      ? msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      : new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ))}

            {generating && (
              <div className="flex gap-2.5 items-center">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <Sparkles size={10} className="text-primary" />
                </div>
                <div className="bg-white border border-bial-border rounded-2xl px-4 py-3 flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }}
                    />
                  ))}
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="bg-white border-t border-bial-border p-4 flex-shrink-0">
            <div className="max-w-3xl mx-auto">
              {error && (
                <div className="mb-2 text-xs text-danger bg-danger/5 border border-danger/20 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
              {/* Context-length guardrail: warn as it grows, hard-stop at the window */}
              {ctxLevel === 'full' ? (
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-danger bg-danger/5 border border-danger/20 rounded-lg px-3 py-2">
                  <span>This conversation has reached its maximum length. Start a new chat to keep going.</span>
                  <button onClick={handleNewChat} className="font-bold underline whitespace-nowrap">
                    Start new chat
                  </button>
                </div>
              ) : ctxLevel === 'warn' ? (
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-tertiary bg-warning/10 border border-warning/30 rounded-lg px-3 py-2">
                  <span>This conversation is getting long. For the best results, start a new chat.</span>
                  <button onClick={handleNewChat} className="font-bold text-primary underline whitespace-nowrap">
                    New chat
                  </button>
                </div>
              ) : null}
              {/* Pending attachment preview row */}
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {pendingAttachments.map((a) => (
                    <div
                      key={a.id}
                      className="group relative flex items-center gap-1.5 bg-bial-bg border border-bial-border rounded-lg px-2 py-1.5 text-xs text-tertiary"
                    >
                      {TEXT_MEDIA_TYPES.has(a.mediaType) ? (
                        <span className="flex-shrink-0 text-primary" title={a.name}>
                          {a.mediaType === 'text/csv' ? <FileSpreadsheet size={13} /> : <FileText size={13} />}
                        </span>
                      ) : a.mediaType === 'application/pdf' ? (
                        <button
                          type="button"
                          onClick={() => openPdf(a.base64, a.name)}
                          title={`Open ${a.name}`}
                          className="flex-shrink-0 text-primary hover:opacity-80 transition"
                        >
                          <FileText size={13} />
                        </button>
                      ) : (
                        <img
                          src={`data:${a.mediaType};base64,${a.base64}`}
                          alt={a.name}
                          title={`View ${a.name}`}
                          onClick={() => setViewer({ name: a.name, src: `data:${a.mediaType};base64,${a.base64}` })}
                          className="h-8 w-8 object-cover rounded cursor-zoom-in hover:opacity-90 transition"
                        />
                      )}
                      <span className="truncate max-w-[10rem]">{a.name}</span>
                      <button
                        onClick={() => removePending(a.id)}
                        className="text-neutral hover:text-danger transition"
                        title="Remove"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-3 items-end">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_ATTR}
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={generating}
                  title="Attach images, PDFs, or text files (CSV, TXT)"
                  className="flex-shrink-0 w-11 h-11 bg-bial-bg hover:bg-surface-muted disabled:opacity-40 text-neutral hover:text-primary border border-bial-border rounded-xl flex items-center justify-center transition"
                >
                  <Paperclip size={15} />
                </button>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  rows={2}
                  placeholder="Describe what you're thinking… (Shift+Enter for new line)"
                  className="flex-1 resize-none text-sm text-tertiary bg-bial-bg border border-bial-border rounded-xl px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition placeholder:text-gray-300"
                />
                <button
                  onClick={handleSend}
                  disabled={(!input.trim() && pendingAttachments.length === 0) || generating || ctxLevel === 'full'}
                  className="flex-shrink-0 w-11 h-11 bg-secondary hover:bg-secondary-600 disabled:opacity-40 text-white rounded-xl flex items-center justify-center transition shadow-sm"
                >
                  <Send size={15} />
                </button>
              </div>
            </div>
            <p className="text-[10px] text-center text-neutral/40 uppercase tracking-wider mt-2">
              Press Enter to send · Shift+Enter for new line · Images, PDFs & text files supported
            </p>
          </div>
        </div>
      </div>

      {/* Pending-attachment image lightbox */}
      {viewer && (
        <AttachmentLightbox name={viewer.name} src={viewer.src} onClose={() => setViewer(null)} />
      )}

      {/* Attachment validation / cap toast */}
      {attachToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-white border border-bial-border rounded-xl shadow-xl px-4 py-3 text-sm text-tertiary font-medium max-w-xs">
          {attachToast}
        </div>
      )}

      {/* Build suggestion modal */}
      {showBuildModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8 text-center animate-in">
            <div className="w-14 h-14 rounded-2xl bg-secondary/10 flex items-center justify-center mx-auto mb-5">
              <Hammer size={26} className="text-secondary" />
            </div>
            <h2 className="text-xl font-extrabold text-tertiary mb-2">Ready to build this app?</h2>
            <p className="text-sm text-neutral leading-relaxed mb-8">
              You've mapped out a solid plan. The builder will use your conversation as context to generate the app.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowBuildModal(false)}
                className="flex-1 px-5 py-3 border border-bial-border text-sm font-bold text-neutral rounded-xl hover:bg-surface-muted transition"
              >
                Continue Planning
              </button>
              <button
                onClick={handleBuildApp}
                className="flex-1 px-5 py-3 bg-secondary hover:bg-secondary-600 text-white text-sm font-bold rounded-xl transition shadow-sm shadow-secondary/30 flex items-center justify-center gap-2"
              >
                Build This App <Sparkles size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
