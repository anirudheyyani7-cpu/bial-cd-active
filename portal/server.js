/**
 * BIAL Citizen Developer Portal — Express server (single origin).
 *
 * Keeps ANTHROPIC_FOUNDRY_API_KEY server-side; proxies streaming SSE requests
 * to the Azure AI Foundry Anthropic Messages API. Also hosts the interim auth
 * API (/api/auth/*), gates /api/claude behind a Bearer-JWT middleware, applies
 * a baseline CSP, and serves the built SPA so relative /api/* keeps working in
 * production.
 *
 * Usage:
 *   npm run server        # Express on :3001 (serves API + built SPA)
 *   npm run dev:full      # Vite (:5173) + Express (:3001) for development
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk'
import dotenv from 'dotenv'
import { requireAuth } from './server/auth/middleware.js'
import { createAuthRouter } from './server/auth/routes.js'
import { validateTokenConfig } from './server/auth/tokens.js'
import { createUsersRepo } from './server/users-repo.js'
import { getUsersCollection } from './server/cosmos.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST = path.join(__dirname, 'dist')

/**
 * Resolve the Express `trust proxy` setting. CRITICAL for correct rate-limiting:
 * it must equal the real number of proxy hops that append to X-Forwarded-For in
 * the deployment so req.ip is the actual client IP, not a shared LB address —
 * which would make the per-IP limiter lock out everyone behind that proxy. Never
 * `true` (clients could spoof X-Forwarded-For). Default 1; override with
 * TRUST_PROXY (an integer hop count, or a CIDR/keyword like 'loopback').
 */
function resolveTrustProxy() { // NOSONAR(javascript:S3800) — union return is intentional (see below)
  // The number|string union is REQUIRED, not a smell: Express reads a number as a
  // proxy-hop count but a string as a CIDR/keyword spec, so '1' (string) ≠ 1
  // (number) and the two cases cannot share a JS type. This mirrors Express's own
  // accepted `trust proxy` type (boolean | number | string | string[] | fn).
  const tp = process.env.TRUST_PROXY
  if (tp === undefined || tp.trim() === '') return 1
  const t = tp.trim()
  return /^\d+$/.test(t) ? Number(t) : t
}

/**
 * Build the Express app. Dependencies are injected so the integration suite
 * can supply a fake users-repo and a mocked Foundry client without a port,
 * live Cosmos, or a real upstream call.
 */
export function createApp({ repo, claudeClient, distDir = DEFAULT_DIST } = {}) {
  const app = express()
  app.set('trust proxy', resolveTrustProxy())

  // R17 — baseline Content-Security-Policy + security headers, applied to ALL
  // responses. Tuned minimally so the built SPA and same-origin SSE work; full
  // policy tuning is deferred but a permissive baseline is not.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Google Fonts: stylesheet from googleapis, font files from gstatic
          // (the SPA imports them in index.css). 'unsafe-inline' covers React
          // inline style attributes.
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      // Allow the SPA's own assets to load cross-context where needed.
      crossOriginEmbedderPolicy: false,
    }),
  )

  // Dev convenience only: the Vite origin. Single-origin prod needs no CORS.
  app.use(cors({ origin: ['http://localhost:5173'] }))
  app.use(express.json())

  // --- API routes (registered BEFORE the SPA fallback) -------------------
  // repo is required: with it omitted, /api/auth/* would silently 404 and the
  // SPA fallback would answer with index.html, so the client's res.json() would
  // throw. Fail loud here, matching createAuthRouter's own guard.
  if (!repo) throw new Error('createApp: repo is required')
  app.use('/api/auth', createAuthRouter({ repo }))

  app.post('/api/claude', requireAuth, async (req, res) => {
    const { model, max_tokens, system, messages } = req.body

    // claudeClient is optional in the DI seam; fail clearly with a 503 instead
    // of throwing a raw TypeError deep inside the streaming handler.
    if (!claudeClient) {
      return res.status(503).json({ error: { message: 'Claude client not configured.' } })
    }

    if (!process.env.ANTHROPIC_FOUNDRY_API_KEY) {
      return res
        .status(500)
        .json({ error: { message: 'ANTHROPIC_FOUNDRY_API_KEY not set. Copy .env.example to .env.' } })
    }

    try {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      const stream = await claudeClient.messages.stream({
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

  // --- Static SPA + history fallback (AFTER all /api routes) -------------
  app.use(express.static(distDir))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next() // never shadow the API
    res.sendFile(path.join(distDir, 'index.html'))
  })

  return app
}

/** Production entry: init Cosmos, build the app with real deps, and listen. */
async function start() {
  validateTokenConfig() // fail loud on a bad JWT secret / token TTL before boot
  const collection = await getUsersCollection() // connect to the pre-created users collection; fails loud
  const repo = createUsersRepo(collection)
  const claudeClient = new AnthropicFoundry({
    apiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY,
    baseURL: `https://${process.env.AZURE_FOUNDRY_RESOURCE_NAME}.services.ai.azure.com/anthropic`,
    apiVersion: '2023-06-01',
  })

  const app = createApp({ repo, claudeClient })
  const PORT = process.env.PORT || 3001
  app.listen(PORT, () => console.log(`✈  BIAL portal (API + SPA) → http://localhost:${PORT}`))
}

// Start only when run directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error('Failed to start server:', err.message)
    process.exit(1)
  })
}
