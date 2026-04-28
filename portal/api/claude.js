import Anthropic from '@anthropic-ai/sdk'

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } })
  }

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: { message: 'ANTHROPIC_API_KEY not set in Vercel environment variables.' },
    })
  }

  const { model, max_tokens, system, messages } = req.body

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const stream = await client.messages.stream({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 16000,
      system,
      messages,
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ delta: { text: event.delta.text } })}\n\n`)
      }
    }

    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    console.error('Claude API error:', err.message)
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } })
    } else {
      res.end()
    }
  }
}
