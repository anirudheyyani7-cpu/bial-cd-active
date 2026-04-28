/**
 * BIAL Citizen Developer Portal — Claude API Relay Server
 *
 * Keeps ANTHROPIC_API_KEY server-side; proxies streaming SSE requests
 * from the Vite frontend to the Anthropic Messages API.
 *
 * Usage:
 *   npm run server        # relay only on :3001
 *   npm run dev:full      # Vite (:5173) + relay (:3001) together
 */

import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3000'] }))
app.use(express.json())

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.post('/api/claude', async (req, res) => {
  const { model, max_tokens, system, messages } = req.body

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set. Copy .env.example to .env.' } })
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const stream = await client.messages.stream({
      model: model || 'claude-opus-4-7',
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
    }
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`✈  BIAL Claude relay → http://localhost:${PORT}`))
