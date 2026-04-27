import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Send, ArrowLeft, Bot, User, Bell } from 'lucide-react'
import SkyLinkLogo from '../components/SkyLinkLogo'
import LivePreview from '../components/LivePreview'
import { useClaudeAPI } from '../hooks/useClaudeAPI'

const CHIPS = [
  'Change the theme to dark mode',
  'Add a real-time data table',
  'Add export to PDF button',
  'Show summary statistics',
]

function welcome(prompt) {
  return {
    id: 'init',
    role: 'assistant',
    content: `I've received your request and I'm ready to build.\n\n**Your brief:** ${prompt}\n\nDescribe any adjustments or just say "generate" and I'll create the live preview now.`,
    timestamp: new Date(),
  }
}

function MessageContent({ content, streaming }) {
  if (!content && streaming) return <span className="inline-block w-2 h-3 bg-primary animate-pulse rounded-sm" />
  const parts = content.split(/(\*\*[^*]+\*\*|\n)/g)
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
        if (part === '\n') return <br key={i} />
        if (part.includes('```jsx:preview')) return null
        return <span key={i}>{part}</span>
      })}
      {streaming && <span className="inline-block w-1.5 h-3 bg-primary animate-pulse rounded-sm ml-0.5" />}
    </span>
  )
}

export default function BuilderPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const initialPrompt = location.state?.prompt || ''
  const { sendMessage, loading } = useClaudeAPI()

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (initialPrompt) {
      const initMsg = welcome(initialPrompt)
      setMessages([initMsg])
      generate(initialPrompt, [initMsg])
    } else {
      setMessages([{
        id: 'welcome',
        role: 'assistant',
        content: "Hello! I'm SkyLink Builder AI. Tell me what you'd like to build for BIAL operations.",
        timestamp: new Date(),
      }])
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const generate = async (userText, current) => {
    setGenerating(true)
    const history = current
      .filter((m) => m.id !== 'init' && m.id !== 'welcome')
      .map((m) => ({ role: m.role, content: m.content }))

    const placeholder = { id: Date.now().toString(), role: 'assistant', content: '', timestamp: new Date(), streaming: true }
    setMessages((prev) => [...prev, placeholder])

    const result = await sendMessage([...history, { role: 'user', content: userText }], (_, full) => {
      setMessages((prev) => prev.map((m) => m.id === placeholder.id ? { ...m, content: full } : m))
    })

    setMessages((prev) =>
      prev.map((m) => m.id === placeholder.id
        ? { ...m, content: result || '⚠️ Could not reach SkyLink Builder AI. Check that the relay server is running (`npm run server`) and your ANTHROPIC_API_KEY is set in `.env`.', streaming: false }
        : m
      )
    )
    setGenerating(false)
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
      {/* Navbar */}
      <nav className="bg-white border-b border-bial-border z-40 flex-shrink-0">
        <div className="px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate('/sandbox')} className="p-1.5 rounded-lg text-neutral hover:text-primary hover:bg-bial-bg transition">
              <ArrowLeft size={17} />
            </button>
            <SkyLinkLogo />
            <div className="hidden md:flex items-center gap-6">
              {['My Apps', 'Help'].map((item) => (
                <a key={item} href="#" className="text-sm text-neutral hover:text-primary transition font-medium">{item}</a>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="p-2 text-neutral hover:text-primary transition rounded-lg hover:bg-bial-bg"><Bell size={17} /></button>
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
              <User size={13} className="text-primary" />
            </div>
          </div>
        </div>
      </nav>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="w-72 xl:w-80 flex flex-col bg-white border-r border-bial-border flex-shrink-0">
          {/* Agent header */}
          <div className="p-4 border-b border-bial-border">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
                  <Bot size={17} className="text-white" />
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-400 rounded-full border-2 border-white" />
              </div>
              <div>
                <p className="text-sm font-bold text-tertiary">SkyLink Builder</p>
                <p className="text-xs text-neutral">Refinement Specialist</p>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${msg.role === 'assistant' ? 'bg-primary/10' : 'bg-secondary/10'}`}>
                  {msg.role === 'assistant'
                    ? <Bot size={12} className="text-primary" />
                    : <User size={12} className="text-secondary" />
                  }
                </div>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2.5 text-xs leading-relaxed ${
                  msg.role === 'user' ? 'bg-tertiary text-white rounded-tr-sm' : 'bg-bial-bg text-tertiary rounded-tl-sm'
                }`}>
                  <MessageContent content={msg.content} streaming={msg.streaming} />
                  <p className="text-[10px] mt-1 opacity-40">
                    {msg.timestamp?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ))}
            {loading && !generating && (
              <div className="flex gap-2 items-center">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                  <Bot size={12} className="text-primary" />
                </div>
                <div className="bg-bial-bg rounded-2xl px-3 py-2.5 flex gap-1">
                  {[0,1,2].map((i) => (
                    <div key={i} className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input area */}
          <div className="p-3 border-t border-bial-border space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {CHIPS.map((chip) => (
                <button
                  key={chip}
                  onClick={() => { setInput(chip); inputRef.current?.focus() }}
                  className="text-[10px] font-worksans text-neutral bg-bial-bg border border-bial-border rounded-full px-2.5 py-1 hover:border-primary hover:text-primary transition"
                >
                  {chip}
                </button>
              ))}
            </div>
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

        {/* Live preview */}
        <div className="flex-1 flex flex-col relative overflow-hidden">
          <LivePreview messages={messages} generating={generating} />
        </div>
      </div>
    </div>
  )
}
