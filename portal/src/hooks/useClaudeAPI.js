import { useState, useCallback } from 'react'

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
  const { dataSource, theme, hasSchema } = context
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

export function useClaudeAPI() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const sendMessage = useCallback(async (messages, onChunk, context) => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 16000,
          system: buildSystemPrompt(context),
          messages: truncateMessages(messages).map((m) => ({ role: m.role, content: m.content })),
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error?.message || `API error ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''

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

      setLoading(false)
      return fullText
    } catch (err) {
      setError(err.message)
      setLoading(false)
      return null
    }
  }, [])

  return { sendMessage, loading, error }
}
