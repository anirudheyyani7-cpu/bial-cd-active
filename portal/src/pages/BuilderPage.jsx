import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Send, ArrowLeft, Sparkles, User, Brain, LayoutTemplate, Code2, Monitor, CheckCircle, X } from 'lucide-react'
import Navbar from '../components/layout/Navbar'
import LivePreview from '../components/LivePreview'
import { useClaudeAPI } from '../hooks/useClaudeAPI'

const STAGE_MESSAGES = [
  'Got it! Analyzing your requirements and identifying the right data sources...',
  'Requirements mapped. Creating the wireframe layout for your app...',
  'Wireframe ready. Generating the application code now — this takes a moment...',
  'Code generation complete. Rendering your live preview...',
  "Your app is ready! I've loaded the preview on the right. You can interact with it, or tell me what you'd like to change.",
]

const TOAST_STAGES = [
  { text: 'Analyzing requirements...', Icon: Brain },
  { text: 'Building wireframe...', Icon: LayoutTemplate },
  { text: 'Generating code...', Icon: Code2 },
  { text: 'Rendering preview...', Icon: Monitor },
]

const REFINEMENT_CHIPS = [
  'Change the theme to dark mode',
  'Add a real-time data table',
  'Switch to mobile layout',
]

function extractPreviewCode(text) {
  if (!text) return null
  const match = text.match(/```jsx:preview\s*([\s\S]*?)```/)
  return match ? match[1].trim() : null
}

function filterCodeFromContent(content) {
  if (!content) return ''
  return content
    .replace(/```jsx:preview[\s\S]*?```/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim()
}

function Toast({ stage, done, visible, onDismiss }) {
  if (!visible) return null

  const current = stage >= 1 && stage <= 4 ? TOAST_STAGES[stage - 1] : null

  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-start gap-3 bg-white border border-bial-border rounded-xl shadow-xl p-4 max-w-xs animate-in slide-in-from-bottom-2">
      {done ? (
        <>
          <CheckCircle size={18} className="text-green-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-bold text-tertiary">App Generated Successfully</p>
            <p className="text-xs text-neutral mt-0.5">Your preview is ready. Interact with it or refine via chat.</p>
          </div>
        </>
      ) : current ? (
        <>
          <div className="w-5 h-5 bg-primary/10 rounded flex items-center justify-center flex-shrink-0 mt-0.5">
            <current.Icon size={11} className="text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-semibold text-tertiary">{current.text}</p>
          </div>
        </>
      ) : null}
      <button onClick={onDismiss} className="text-neutral hover:text-tertiary transition flex-shrink-0 mt-0.5">
        <X size={13} />
      </button>
    </div>
  )
}

function MessageContent({ content }) {
  const filtered = filterCodeFromContent(content)
  if (!filtered) return null
  const parts = filtered.split(/(\*\*[^*]+\*\*|\n)/g)
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
        if (part === '\n') return <br key={i} />
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

export default function BuilderPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const initialPrompt = location.state?.prompt || ''
  const contextRef = useRef({
    dataSource: location.state?.dataSource || null,
    theme: location.state?.theme || 'bial',
    hasSchema: location.state?.hasSchema || false,
  })
  const { sendMessage } = useClaudeAPI()

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)
  const [previewCode, setPreviewCode] = useState(null)
  const [generationStage, setGenerationStage] = useState(0)
  const [toast, setToast] = useState({ stage: 0, done: false, visible: false })

  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const timerRefs = useRef([])
  const toastTimer = useRef(null)

  useEffect(() => {
    return () => {
      timerRefs.current.forEach(clearTimeout)
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  useEffect(() => {
    if (initialPrompt) {
      const userMsg = {
        id: 'initial-user',
        role: 'user',
        content: initialPrompt,
        timestamp: new Date(),
      }
      setMessages([userMsg])
      generate(initialPrompt, [userMsg])
    } else {
      setMessages([{
        id: 'welcome',
        role: 'assistant',
        content: "Hello! I'm Citizen Developer AI. Tell me what you'd like to build for BIAL operations.",
        timestamp: new Date(),
      }])
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const clearTimers = () => {
    timerRefs.current.forEach(clearTimeout)
    timerRefs.current = []
  }

  const generate = async (userText, currentMessages) => {
    setGenerating(true)
    setGenerationStage(1)
    clearTimers()

    const addStage = (index) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `stage-${index}-${Date.now()}`,
          role: 'assistant',
          content: STAGE_MESSAGES[index],
          timestamp: new Date(),
          isStage: true,
          showChips: index === 4,
        },
      ])
    }

    addStage(0)
    setToast({ stage: 1, done: false, visible: true })

    timerRefs.current.push(setTimeout(() => { setGenerationStage(2); addStage(1); setToast({ stage: 2, done: false, visible: true }) }, 3000))
    timerRefs.current.push(setTimeout(() => { setGenerationStage(3); addStage(2); setToast({ stage: 3, done: false, visible: true }) }, 6000))
    timerRefs.current.push(setTimeout(() => { setGenerationStage(4); addStage(3); setToast({ stage: 4, done: false, visible: true }) }, 10000))

    const history = currentMessages
      .filter((m) => !m.isStage && m.id !== 'welcome')
      .map((m) => ({ role: m.role, content: m.content }))

    const result = await sendMessage(
      [...history, { role: 'user', content: userText }],
      (_, full) => {
        const code = extractPreviewCode(full)
        if (code) setPreviewCode(code)
      },
      contextRef.current
    )

    clearTimers()

    const finalCode = extractPreviewCode(result || '')
    if (finalCode) setPreviewCode(finalCode)

    setGenerationStage(5)
    addStage(4)
    setToast({ stage: 0, done: true, visible: true })
    setGenerating(false)

    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, visible: false })), 6000)
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || generating) return
    setInput('')
    const userMsg = { id: Date.now().toString(), role: 'user', content: text, timestamp: new Date() }
    const updated = [...messages, userMsg]
    setMessages(updated)
    await generate(text, updated)
  }

  return (
    <div className="h-screen flex flex-col font-manrope bg-bial-bg overflow-hidden">
      <Navbar />

      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="w-72 xl:w-80 flex flex-col bg-white border-r border-bial-border flex-shrink-0">
          {/* Agent header */}
          <div className="p-4 border-b border-bial-border">
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => navigate('/workspace/sandbox')}
                className="p-1 rounded-lg text-neutral hover:text-primary hover:bg-bial-bg transition"
              >
                <ArrowLeft size={15} />
              </button>
              <span className="text-xs text-neutral">Back to Sandbox</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
                  <Sparkles size={17} className="text-white" />
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-400 rounded-full border-2 border-white" />
              </div>
              <div>
                <p className="text-sm font-bold text-tertiary">Citizen Developer AI</p>
                <p className="text-xs text-neutral">powered by Anthropic</p>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
            {messages.map((msg) => (
              <div key={msg.id}>
                <div className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${msg.role === 'assistant' ? 'bg-primary/10' : 'bg-secondary/10'}`}>
                    {msg.role === 'assistant'
                      ? <Sparkles size={10} className="text-primary" />
                      : <User size={10} className="text-secondary" />
                    }
                  </div>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2.5 text-xs leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-tertiary text-white rounded-tr-sm'
                      : 'bg-bial-bg text-tertiary rounded-tl-sm'
                  }`}>
                    <MessageContent content={msg.content} />
                    <p className="text-[10px] mt-1 opacity-40">
                      {msg.timestamp?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>

                {msg.showChips && (
                  <div className="ml-8 mt-2 flex flex-wrap gap-1.5">
                    {REFINEMENT_CHIPS.map((chip) => (
                      <button
                        key={chip}
                        onClick={() => { setInput(chip); inputRef.current?.focus() }}
                        className="text-[10px] font-worksans text-neutral bg-white border border-bial-border rounded-full px-2.5 py-1 hover:border-primary hover:text-primary transition"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {generating && (
              <div className="flex gap-2 items-center">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <Sparkles size={10} className="text-primary" />
                </div>
                <div className="bg-bial-bg rounded-2xl px-3 py-2.5 flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="p-3 border-t border-bial-border space-y-2">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                rows={2}
                placeholder="Type instructions to refine your app..."
                className="flex-1 resize-none text-xs text-tertiary bg-bial-bg border border-bial-border rounded-xl px-3 py-2 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition placeholder:text-gray-300"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || generating}
                className="flex-shrink-0 w-9 h-9 bg-secondary hover:bg-secondary-600 disabled:opacity-40 text-white rounded-xl flex items-center justify-center transition"
              >
                <Send size={13} />
              </button>
            </div>
            <p className="text-[9px] text-center text-neutral/40 uppercase tracking-wider">Press Enter to send</p>
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <LivePreview
            previewCode={previewCode}
            generating={generating}
            generationStage={generationStage}
            prompt={initialPrompt}
          />
        </div>
      </div>

      <Toast
        stage={toast.stage}
        done={toast.done}
        visible={toast.visible}
        onDismiss={() => setToast((t) => ({ ...t, visible: false }))}
      />
    </div>
  )
}
