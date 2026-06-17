import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { Sparkles, User, Send, Plus, MessageSquare, Trash2, Hammer, Paperclip, X, FileText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import Navbar from '../components/layout/Navbar'
import AttachmentChips from '../components/AttachmentChips'
import { useClaudeAPI } from '../hooks/useClaudeAPI'
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
import { buildContentBlocks, contentToText, getAttachment, putAttachment } from '../utils/attachmentStore'
import { ACCEPT_ATTR, toAttachmentRef } from '../utils/attachmentInput'

const PLANNING_SYSTEM_PROMPT = `You are Citizen Developer AI, a planning assistant for the Bengaluru International Airport (BIAL) Citizen Developer Portal.

Your role in this mode is to help airport staff plan and define their app requirements through conversation — NOT to generate code yet.

Guidelines:
- Ask clarifying questions to understand the user's operational need
- Help them articulate what their app should do, who will use it, and what data it needs
- Suggest features based on airport operations context (flight tracking, staff rostering, baggage, gate management, etc.)
- Keep responses concise and practical — staff are busy
- When you feel the requirements are well-defined, summarise the plan and suggest moving to the builder

Do not output code or JSX. Stay focused on requirements gathering and planning.`

function MessageContent({ content, attachments, isUser }) {
  // content may be a string or a ContentBlock[]; always derive plain text so
  // react-markdown / the user div never receives an array → no [object Object].
  const text = contentToText(content)
  return (
    <>
      {attachments?.length > 0 && <AttachmentChips attachments={attachments} />}
      {isUser ? (
        <div className="whitespace-pre-wrap break-words">{text}</div>
      ) : (
        <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-strong:text-tertiary prose-ul:pl-4 prose-ol:pl-4">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
    </>
  )
}

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
  const buildSuggestionFiredRef = useRef(false)

  const { sendMessage } = useClaudeAPI()
  const { pendingAttachments, handleFileSelect, removePending, clearPending, attachToast, showAttachToast } =
    usePendingAttachments()
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

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

  const fireMessage = useCallback(async (rawText, attachments = []) => {
    if (generating) return
    const text = rawText.trim() || (attachments.length ? 'Please review the attached file(s).' : '')
    if (!text && attachments.length === 0) return
    const currentChatId = activeChatId

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
    const apiMessages = await Promise.all(
      [...messagesRef.current, userMsg].map(async (m) => ({
        role: m.role,
        content: m.attachments?.length
          ? await buildContentBlocks(contentToText(m.content), m.attachments, getAttachment)
          : m.content,
      })),
    )

    const assistantId = `msg_${Date.now()}_a`
    let assistantText = ''

    setMessages((prev) => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    }])

    await sendMessage(
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
    setInput('')
    clearPending()

    if (!activeChatId) {
      const id = newConversation(text || 'Attachment')
      setActiveChatId(id)
      navigate(`/workspace/chat/${id}`, { replace: true })
      // fireMessage will be called by the activeChatId effect? No — we need to fire it directly here
      // since the effect only fires for initial messages from location.state
      setTimeout(() => fireMessage(text, attachments), 0)
    } else {
      fireMessage(text, attachments)
    }
  }

  const handleSelectChat = (id) => {
    navigate(`/workspace/chat/${id}`)
    buildSuggestionFiredRef.current = false
  }

  const handleNewChat = () => {
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
              {/* Pending attachment preview row */}
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {pendingAttachments.map((a) => (
                    <div
                      key={a.id}
                      className="group relative flex items-center gap-1.5 bg-bial-bg border border-bial-border rounded-lg px-2 py-1.5 text-xs text-tertiary"
                    >
                      {a.mediaType === 'application/pdf' ? (
                        <FileText size={13} className="text-primary flex-shrink-0" />
                      ) : (
                        <img
                          src={`data:${a.mediaType};base64,${a.base64}`}
                          alt={a.name}
                          className="h-8 w-8 object-cover rounded"
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
                  title="Attach images or PDFs"
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
                  disabled={(!input.trim() && pendingAttachments.length === 0) || generating}
                  className="flex-shrink-0 w-11 h-11 bg-secondary hover:bg-secondary-600 disabled:opacity-40 text-white rounded-xl flex items-center justify-center transition shadow-sm"
                >
                  <Send size={15} />
                </button>
              </div>
            </div>
            <p className="text-[10px] text-center text-neutral/40 uppercase tracking-wider mt-2">
              Press Enter to send · Shift+Enter for new line · Images & PDFs supported
            </p>
          </div>
        </div>
      </div>

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
