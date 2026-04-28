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

export function useClaudeAPI() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const sendMessage = useCallback(async (messages, onChunk) => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
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
