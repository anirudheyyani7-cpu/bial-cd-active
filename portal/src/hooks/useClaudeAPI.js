import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAccessToken, refreshAccessToken, clearSession, SIGNOUT_REASONS } from '../utils/auth.js'
import { notifyUsageChanged } from '../utils/usage.js'
import { TEXT_MEDIA_TYPES } from '../utils/attachmentInput.js'

const SYSTEM_PROMPT = `You are Citizen Developer AI, an expert app generation and refinement specialist for the Bengaluru International Airport (BIAL) Citizen Developer Portal, powered by Anthropic.

Your role:
- Help airport staff build operational tools by generating and refining app components
- Respond in clear, concise language appropriate for non-developer airport staff
- When asked to generate or update a UI, output valid JSX React code inside a code block tagged \`jsx:preview\`
- Always maintain the BIAL design system: Primary #00818A, Secondary #D9A036, Tertiary #1A2B34
- Use Tailwind CSS classes only (no custom CSS)
- Generated apps should be practical for airport operations: flight tracking, staff rostering, baggage, gate management, equipment maintenance, etc.
- If the user attaches images (screenshots, mockups) or PDFs (specs, sample data), examine them and build the app to match what they show — you can see attachments, so use their real content

When generating a preview app:
1. Wrap JSX in \`\`\`jsx:preview ... \`\`\`
2. Always return a self-contained functional React component named \`PreviewApp\`
3. Use only inline Tailwind classes
4. Include realistic placeholder data relevant to the airport context
5. Do NOT use import or export statements — React and its hooks (useState, useEffect, useRef, etc.) are available globally. Do not use external libraries (no icon packs); use inline SVG or text/emoji if needed.

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

export function buildSystemPrompt(context) {
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

// Backstop for the silent truncation in truncateMessages. Raised from the old
// 50k cost-control cap to sit under the 200k model window minus the 16k
// max_tokens output budget, so an allowed near-limit send still fits the window
// (no API "prompt too long"). The user-facing guardrail (CONTEXT_* below) warns
// at 150k and blocks at 200k; this backstop only trims for a user who pushed
// past the visible 150k warning.
const INPUT_TOKEN_BUDGET = 180_000
const CHARS_PER_TOKEN = 4
// Flat nominal budget cost for one attachment block. The real token cost is
// counted server-side; this only keeps the client-side history estimate from
// either crashing on an array or under-counting a multi-MB file as ~2 tokens.
const NOMINAL_FILE_TOKENS = 1_600

// content is `string | ContentBlock[]`. Never call `.length` on a non-string:
// for an array, sum the text blocks and add a flat per-file nominal (NOT the
// element count) for each image/document block.
function estimateContentTokens(content) {
  if (typeof content === 'string') return Math.ceil(content.length / CHARS_PER_TOKEN)
  if (!Array.isArray(content)) return 0
  let tokens = 0
  for (const block of content) {
    if (block?.type === 'text') tokens += Math.ceil((block.text || '').length / CHARS_PER_TOKEN)
    else tokens += NOMINAL_FILE_TOKENS
  }
  return tokens
}

export function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateContentTokens(m.content), 0)
}

export function truncateMessages(messages) {
  if (estimateTokens(messages) <= INPUT_TOKEN_BUDGET) return messages
  const [first, ...rest] = messages
  while (rest.length > 1 && estimateTokens([first, ...rest]) > INPUT_TOKEN_BUDGET) {
    rest.shift()
  }
  return [first, ...rest]
}

// Conversation context-length guardrail, anchored to the 200k Opus 4.7 window.
// The chat surfaces warn at SOFT (non-blocking banner + "new chat" CTA) and
// hard-block at HARD (banner + disabled send). Both sit clear of the silent
// truncation backstop so an un-warned user is never surprised by a dropped turn.
export const CONTEXT_SOFT_LIMIT = 150_000
export const CONTEXT_HARD_LIMIT = 200_000

/**
 * Estimate a conversation's input size the way assembleApiMessages actually
 * sends it: text for every turn + the system prompt + attachment costs. Mirrors
 * the sticky/newest-only split in assembleApiMessages —
 *  - TEXT attachments are sticky (re-sent every turn), so each is counted on
 *    EVERY turn it appears, by its byte size (size / CHARS_PER_TOKEN) — a 200 KB
 *    CSV is ~50k tokens, not a flat 1600.
 *  - IMAGE/PDF attachments send only on the newest turn, so they're counted as a
 *    flat per-file nominal there and ignored on older turns.
 * Heuristic (4 chars/token) used only to drive the warn/block UI — never to gate
 * the API call directly.
 */
export function estimateConversationTokens(messages, systemText = '') {
  if (!Array.isArray(messages)) return 0
  const textTokens = estimateTokens(messages)
  const systemTokens = Math.ceil((systemText?.length || 0) / CHARS_PER_TOKEN)
  const lastIdx = messages.length - 1
  let attachmentTokens = 0
  messages.forEach((m, i) => {
    for (const a of m?.attachments || []) {
      if (TEXT_MEDIA_TYPES.has(a.mediaType)) {
        attachmentTokens += Math.ceil((a.size || 0) / CHARS_PER_TOKEN)
      } else if (i === lastIdx) {
        attachmentTokens += NOMINAL_FILE_TOKENS
      }
    }
  })
  return textTokens + systemTokens + attachmentTokens
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
    // Daily token limit: surface a user-ready message (the existing setError
    // path renders it). A 429 WITHOUT the known code falls through to the
    // generic error so other rate limits keep their server message.
    if (response.status === 429 && errBody.error?.code === 'daily_token_limit_exceeded') {
      const limit = errBody.error?.limit
      throw new Error(
        limit
          ? `You've hit your daily limit of ${limit.toLocaleString('en-US')} tokens. It resets at midnight IST.`
          : "You've hit your daily token limit. It resets at midnight IST.",
      )
    }
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
        // A turn completed → server-side usage advanced; nudge the navbar badge.
        notifyUsageChanged()
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
