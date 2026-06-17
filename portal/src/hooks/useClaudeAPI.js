import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAccessToken, refreshAccessToken, clearSession, SIGNOUT_REASONS } from '../utils/auth.js'

const SYSTEM_PROMPT = `You are Citizen Developer AI, an expert app generation and refinement specialist for the Bengaluru International Airport (BIAL) Citizen Developer Portal, powered by Anthropic.

Your role:
- Help airport staff build operational tools by generating and refining app components
- Respond in clear, concise language appropriate for non-developer airport staff
- When asked to generate or update a UI, output valid JSX React code inside a code block tagged \`jsx:preview\`
- Always maintain the BIAL design system: Primary #00818A, Secondary #D9A036, Tertiary #1A2B34
- Use Tailwind CSS classes only (no custom CSS)
- Generated apps should be practical for airport operations: flight tracking, staff rostering, baggage, gate management, equipment maintenance, etc.

When generating a preview app:
1. Wrap JSX in \`\`\`jsx:preview ... \`\`\`
2. Always return a self-contained functional React component named \`PreviewApp\`
3. Use only inline Tailwind classes
4. Include realistic placeholder data relevant to the airport context

When refining, acknowledge what changed and suggest next steps.`

const DATA_SOURCE_LABELS = {
  aodb: 'AODB (Airport Operations Database)',
  dar: 'DAR (Daily Airport Report)',
  vision: 'Vision Analytics System',
  namaskara: 'Namaskara Terminal',
  xovis: 'Xovis (Crowd Management)',
  fids: 'Flight Information Display (FIDS)',
  bhs: 'BHS Telemetry (Baggage Handling System)',
  passenger: 'Passenger Flow Analytics',
  none: 'None / Custom (user-defined data)',
}

const THEME_LABELS = {
  bial: 'Bangalore Airport Theme — use official BIAL teal (#00818A) and amber (#D9A036) brand colors',
  mobile: 'App Style (iOS/Android) — clean mobile-first layout, card-based, bottom navigation',
  dashboard: 'Dashboard / Analytics — data-dense layout with charts, tables, and KPI metrics',
  kiosk: 'Kiosk / Public Display — large text, high contrast, minimal interaction, touch-friendly',
}

function buildSystemPrompt(context) {
  if (!context) return SYSTEM_PROMPT
  if (context.systemPrompt) return context.systemPrompt
  const { dataSource, theme, hasSchema, uploadedFiles = [] } = context
  const lines = []
  if (dataSource && dataSource !== 'none') {
    lines.push(`- **Data source selected:** ${DATA_SOURCE_LABELS[dataSource] || dataSource} — use field names, entities, and mock data consistent with this system`)
  }
  if (theme) {
    lines.push(`- **UI style selected:** ${THEME_LABELS[theme] || theme}`)
  }
  if (hasSchema) {
    lines.push(`- **Backend schema requested:** Yes — after generating the UI, include a \`## Data Model\` section describing the key entities, fields, and types`)
  }
  if (uploadedFiles.length > 0) {
    lines.push(`- **Uploaded reference data (${uploadedFiles.length} file${uploadedFiles.length > 1 ? 's' : ''}):** Use the data below as the actual dataset when generating the app. Populate tables, charts, and UI with real values from this data instead of generic placeholders.`)
    uploadedFiles.forEach((f) => {
      lines.push(`\n### File: ${f.name}\n\`\`\`\n${f.content}\n\`\`\``)
    })
  }
  if (lines.length === 0) return SYSTEM_PROMPT
  return `${SYSTEM_PROMPT}\n\n## Session Context\nThe user configured these options before starting. Honour them throughout the entire conversation:\n${lines.join('\n')}`
}

const INPUT_TOKEN_BUDGET = 50_000
const CHARS_PER_TOKEN = 4

function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + Math.ceil((m.content || '').length / CHARS_PER_TOKEN), 0)
}

function truncateMessages(messages) {
  if (estimateTokens(messages) <= INPUT_TOKEN_BUDGET) return messages
  const [first, ...rest] = messages
  while (rest.length > 1 && estimateTokens([first, ...rest]) > INPUT_TOKEN_BUDGET) {
    rest.shift()
  }
  return [first, ...rest]
}

const AUTH_FAILED = 'AUTH_REFRESH_FAILED'

/**
 * POST /api/claude with a Bearer access token and consume the SSE stream.
 *
 * If the *initial* response is 401 (BEFORE the stream starts), refresh the
 * access token once and retry. A 401 is never retried once `getReader()` has
 * begun — auth is checked once at admission. Dependencies are injected so this
 * is testable without a React render. Returns the accumulated text.
 */
export async function fetchClaudeStream({
  body,
  onChunk,
  signal,
  fetchImpl = fetch,
  getToken = getAccessToken,
  refresh = refreshAccessToken,
}) {
  const post = (token) =>
    fetchImpl('/api/claude', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })

  let response = await post(getToken())

  // Pre-stream 401 only: refresh once and retry with the rotated token.
  if (response.status === 401) {
    const newToken = await refresh()
    if (!newToken) {
      const err = new Error('Your session has expired. Please sign in again.')
      err.code = AUTH_FAILED
      throw err
    }
    response = await post(newToken)
  }

  if (!response.ok) {
    if (response.status === 401) {
      const err = new Error('Your session has expired. Please sign in again.')
      err.code = AUTH_FAILED
      throw err
    }
    const errBody = await response.json().catch(() => ({}))
    throw new Error(errBody.error?.message || `API error ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let fullText = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.delta?.text || ''
          if (delta) {
            fullText += delta
            onChunk?.(delta, fullText)
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } catch (err) {
    // Aborting (logout/unmount) mid-stream is expected — return what we have.
    if (err?.name === 'AbortError' || signal?.aborted) return fullText
    throw err
  }

  return fullText
}

export function useClaudeAPI() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  // Abort an in-flight stream on unmount (covers logout, which navigates away).
  useEffect(() => () => abortRef.current?.abort(), [])

  const sendMessage = useCallback(
    async (messages, onChunk, context) => {
      setLoading(true)
      setError(null)
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const fullText = await fetchClaudeStream({
          body: {
            model: 'claude-opus-4-7',
            max_tokens: 16000,
            system: buildSystemPrompt(context),
            messages: truncateMessages(messages).map((m) => ({ role: m.role, content: m.content })),
          },
          onChunk,
          signal: controller.signal,
        })
        setLoading(false)
        return fullText
      } catch (err) {
        setLoading(false)
        if (err?.name === 'AbortError' || controller.signal.aborted) return null
        if (err?.code === AUTH_FAILED) {
          // The refresh-failed path already cleared the session, but the
          // refresh-succeeded-then-retry-401 path did not — clear here too so
          // stale tokens can't keep isAuthenticated() passing and trap the user
          // on protected routes until the access token expires on its own.
          clearSession(SIGNOUT_REASONS.EXPIRED)
          navigate('/login')
          return null
        }
        setError(err.message)
        return null
      }
    },
    [navigate],
  )

  return { sendMessage, loading, error }
}
