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
import { createUsageRepo, istDateKey, nextIstMidnightIso } from './server/usage-repo.js'
import { getUsersCollection, getUsageCollection } from './server/cosmos.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST = path.join(__dirname, 'dist')

// Flat per-user/day token ceiling (Decision 5). One env var; the per-user
// override + system_config table are deferred to the FastAPI backend.
const DEFAULT_DAILY_TOKEN_LIMIT = 1_000_000

// Server-side ceiling on a single response's output. The client never asks for
// more than 16k, but max_tokens arrives in the request body, so clamp it here so
// one request can't request an arbitrary output size and amplify spend past the
// daily gate (which only reconciles AFTER a turn completes).
const MAX_OUTPUT_TOKENS = 16_000

/**
 * Validate the optional DAILY_TOKEN_LIMIT env at boot. parseInt is lenient
 * ('1e6'→1, '20mb'→20) and the `|| default` fallback masks NaN/0/negatives, so a
 * typo could silently set a 1-token cap or 429 everyone. Fail loud instead; unset
 * is fine (createApp falls back to DEFAULT_DAILY_TOKEN_LIMIT).
 */
function validateDailyTokenLimit() {
  const raw = process.env.DAILY_TOKEN_LIMIT
  if (raw === undefined || raw.trim() === '') return
  if (!/^\d+$/.test(raw.trim()) || Number(raw.trim()) <= 0) {
    throw new Error(`Invalid DAILY_TOKEN_LIMIT="${raw}": must be a positive integer number of tokens (e.g. 1000000).`)
  }
}

// Relaxed CSP for the ISOLATED builder-preview iframe only (served at /preview).
// The generated app needs CDN React/Babel/Tailwind + inline eval (Babel compiles
// JSX at runtime). Scoping this to its own route keeps the main app's CSP strict —
// the preview runs in a sandboxed, same-origin frame, never touching the SPA policy.
const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://unpkg.com https://cdn.tailwindcss.com",
  "frame-ancestors 'self'", // so the same-origin SPA can frame this renderer
].join('; ')

// Static renderer shell for the builder preview. Receives the generated JSX via
// postMessage (never stored server-side, never in the URL) and renders it,
// re-rendering on each refinement. Babel transforms JSX at runtime; the compiled
// code runs in an IIFE-scoped inline <script> (the classic live-preview pattern,
// same as the prior `type="text/babel"` approach) so repeated renders don't
// collide on the PreviewApp binding. Errors render back through React (no innerHTML).
const PREVIEW_SHELL = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{primary:'#00818A',secondary:'#D9A036',tertiary:'#1A2B34'},fontFamily:{manrope:['Manrope','sans-serif']}}}}</script>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>body{margin:0;font-family:'Manrope',sans-serif;background:#fff;}</style>
</head><body>
<div id="root"></div>
<script>
  var root = ReactDOM.createRoot(document.getElementById('root'));
  function renderPreview(code){
    try {
      // The model may emit ES module syntax; strip imports/exports (React is a
      // global here) and compile JSX with the CLASSIC runtime so Babel doesn't
      // inject an \`import ... "react/jsx-runtime"\` that a classic <script> can't run.
      var cleaned = String(code)
        .replace(/import\\s+[^;]*?from\\s*['"][^'"]+['"];?/g, '')
        .replace(/import\\s*['"][^'"]+['"];?/g, '')
        .replace(/export\\s+default\\s+/g, '')
        .replace(/export\\s+/g, '');
      var compiled = Babel.transform(cleaned, { presets: [['react', { runtime: 'classic' }]] }).code;
      var s = document.createElement('script');
      s.textContent = '(function(){' +
        'var {useState,useEffect,useRef,useMemo,useCallback,useReducer,useContext,Fragment}=React;' +
        compiled + '\\n;window.__PreviewApp=(typeof PreviewApp!=="undefined")?PreviewApp:null;})();';
      document.body.appendChild(s);
      document.body.removeChild(s);
      if (!window.__PreviewApp) throw new Error('Generated code did not define a PreviewApp component.');
      root.render(React.createElement(window.__PreviewApp));
    } catch (err) {
      root.render(React.createElement('pre',
        { style: { color: '#b91c1c', padding: '16px', whiteSpace: 'pre-wrap', font: '13px monospace' } },
        'Preview error:\\n' + String((err && err.message) || err)));
    }
  }
  window.addEventListener('message', function (e) {
    if (e.data && typeof e.data.previewCode === 'string') renderPreview(e.data.previewCode);
  });
  if (window.parent) window.parent.postMessage({ previewReady: true }, '*');
</script>
</body></html>`

/**
 * Allowlisted attachment media types → the magic-number prefix the decoded
 * bytes must start with. The relay validates BOTH (declared type ∈ allowlist AND
 * bytes match) before forwarding, so a client can't smuggle arbitrary bytes
 * under a claimed image/PDF type. WebP is a RIFF container ("RIFF"..."WEBP"); the
 * cheap leading "RIFF" check is sufficient for this interim trust boundary.
 */
const ALLOWED_MEDIA = {
  'image/png': [0x89, 0x50, 0x4e, 0x47], // \x89PNG
  'image/jpeg': [0xff, 0xd8], // \xFF\xD8
  'image/gif': [0x47, 0x49, 0x46, 0x38], // GIF8
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
}

// Upper bound on a single inlined text-attachment block (≈512 KB, ~2× the client
// 256 KB per-file cap to absorb the `<attachment>` wrapper). The client cap is
// advisory/bypassable; this is the real trust boundary for inline text — text
// was previously the only attachment class with no server-side size check.
const TEXT_BLOCK_MAX_CHARS = 512 * 1024

function magicMatches(bytes, magic) {
  if (bytes.length < magic.length) return false
  return magic.every((b, i) => bytes[i] === b)
}

/**
 * Validate every attachment content block in `messages`. Returns an error
 * message string on the first violation, or null when all blocks are valid.
 * String content (no attachments) is unchanged and skipped. Cheap: decodes only
 * a short base64 prefix to check the magic number.
 */
function validateAttachments(messages) {
  if (!Array.isArray(messages)) return null
  for (const msg of messages) {
    const content = msg?.content
    if (!Array.isArray(content)) continue // string content = no attachments (unchanged path)
    for (const block of content) {
      if (block?.type === 'text') {
        // A text block must carry a string; a malformed one would 400 upstream
        // after the relay commits, so reject it cleanly here.
        if (typeof block.text !== 'string') return 'Invalid attachment: malformed text block.'
        // Bound inlined text-attachment blocks. The client caps text files at
        // 256 KB but that's bypassable; this is the server-side bound.
        if (Buffer.byteLength(block.text, 'utf8') > TEXT_BLOCK_MAX_CHARS) {
          return 'A text attachment is too large. Please trim the file and try again.'
        }
        continue
      }
      if (block?.type !== 'image' && block?.type !== 'document') continue
      const src = block.source
      if (!src || src.type !== 'base64' || typeof src.data !== 'string') {
        return 'Invalid attachment: malformed source.'
      }
      // Enforce block.type ↔ media_type: a document block must be a PDF and an
      // image block an image/* type. A mismatched pair (e.g. a document block
      // carrying image/png) would pass the allowlist + magic check below but
      // Anthropic rejects it after the relay commits — surface a clean 400 here.
      const isPdf = src.media_type === 'application/pdf'
      if (block.type === 'document' && !isPdf) {
        return `A document attachment must be a PDF, not ${src.media_type}.`
      }
      if (block.type === 'image' && isPdf) {
        return 'An image attachment must be an image type, not application/pdf.'
      }
      const magic = ALLOWED_MEDIA[src.media_type]
      if (!magic) {
        return `Unsupported attachment type: ${src.media_type}. Allowed: PNG, JPEG, GIF, WebP, PDF.`
      }
      const prefix = Buffer.from(src.data.slice(0, 24), 'base64') // 24 b64 chars → 18 bytes, plenty
      if (!magicMatches(prefix, magic)) {
        return `Attachment bytes do not match the declared type ${src.media_type}.`
      }
      // WebP is a RIFF container; the leading "RIFF" also matches WAV/AVI, so
      // additionally require the "WEBP" form-type at offset 8. (This is a prefix
      // sniff — bytes past the prefix are forwarded unvalidated.)
      if (src.media_type === 'image/webp' && prefix.toString('latin1', 8, 12) !== 'WEBP') {
        return 'Attachment bytes do not match the declared type image/webp.'
      }
    }
  }
  return null
}

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
export function createApp({
  repo,
  usageRepo,
  claudeClient,
  distDir = DEFAULT_DIST,
  dailyTokenLimit = Number.parseInt(process.env.DAILY_TOKEN_LIMIT, 10) || DEFAULT_DAILY_TOKEN_LIMIT,
} = {}) {
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
          // The builder preview is framed from the same-origin /preview route
          // (covered by default-src 'self'); that route ships its own relaxed CSP
          // so the generated app can run without loosening this strict policy.
        },
      },
      // Allow the SPA's own assets to load cross-context where needed.
      crossOriginEmbedderPolicy: false,
    }),
  )

  // Dev convenience only: the Vite origin. Single-origin prod needs no CORS.
  app.use(cors({ origin: ['http://localhost:5173'] }))
  // /api/claude carries base64 attachment blocks, so it needs a large body limit;
  // every OTHER route keeps the tight 100 KB default. Registering the route-
  // specific parser FIRST means it consumes the /api/claude body, after which the
  // global parser's `req._body` guard makes it no-op for that path.
  app.use('/api/claude', express.json({ limit: '35mb' }))
  app.use(express.json())

  // --- API routes (registered BEFORE the SPA fallback) -------------------
  // repo is required: with it omitted, /api/auth/* would silently 404 and the
  // SPA fallback would answer with index.html, so the client's res.json() would
  // throw. Fail loud here, matching createAuthRouter's own guard.
  if (!repo) throw new Error('createApp: repo is required')
  // usageRepo is required too: it backs the daily-limit enforcement gate, and an
  // enforcement control path must never silently no-op (Decision 1). Tests that
  // don't exercise metering inject a trivial in-memory fake.
  if (!usageRepo) throw new Error('createApp: usageRepo is required')
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

    // Server-side attachment validation is the real trust boundary (client
    // accept/type checks are advisory and bypassable). Reject before streaming.
    const attachmentError = validateAttachments(messages)
    if (attachmentError) {
      return res.status(400).json({ error: { message: attachmentError } })
    }

    const username = req.user.sub
    const dateKey = istDateKey()

    // Daily-limit gate. `used` is a SCALAR computed ONCE here and reused by
    // GET /api/usage/today below — one definition, no drift. The check runs
    // BEFORE any SSE header is written so an over-limit user gets clean JSON,
    // never a half-open stream.
    let used
    try {
      const doc = await usageRepo.getUsage(username, dateKey)
      used = (doc?.inputTokens ?? 0) + (doc?.outputTokens ?? 0)
    } catch (err) {
      console.error('Usage read failed:', err.message)
      return res.status(500).json({ error: { message: 'Usage check failed. Please retry.' } })
    }
    if (used >= dailyTokenLimit) {
      return res.status(429).json({
        error: {
          message: `You've reached your daily limit of ${dailyTokenLimit.toLocaleString('en-US')} tokens. It resets at midnight IST.`,
          code: 'daily_token_limit_exceeded',
          limit: dailyTokenLimit,
          used,
          remaining: 0,
        },
      })
    }

    let stream
    try {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      stream = await claudeClient.messages.stream({
        model: model || 'claude-opus-4-7',
        max_tokens: Math.min(Math.max(1, Number(max_tokens) || MAX_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS),
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
      return // headers already sent / stream failed → never run usage capture
    }

    // Post-stream usage capture. The server passes NO AbortSignal and has no
    // req/res close handler, so a client disconnect does NOT abort the upstream
    // drain — finalMessage() RESOLVES on a client abort and those (billed)
    // tokens ARE recorded. Only an UPSTREAM stream error makes finalMessage()
    // reject; we swallow it and accept one dropped increment (under-count)
    // rather than 500 a response that has already ended. Billed input =
    // input + cache_creation + cache_read (the two cache fields are number|null).
    try {
      if (typeof stream?.finalMessage === 'function') {
        const u = (await stream.finalMessage()).usage
        const input =
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        await usageRepo.addUsage(username, dateKey, input, u.output_tokens ?? 0)
      }
    } catch (err) {
      console.error('Usage capture skipped (upstream stream error):', err.message)
    }
  })

  // Authenticated caller's own daily usage, for the navbar badge. Same scalar
  // `used` definition as the gate; `remaining` floors at 0.
  app.get('/api/usage/today', requireAuth, async (req, res) => {
    try {
      const doc = await usageRepo.getUsage(req.user.sub, istDateKey())
      const used = (doc?.inputTokens ?? 0) + (doc?.outputTokens ?? 0)
      return res.json({
        used,
        limit: dailyTokenLimit,
        remaining: Math.max(0, dailyTokenLimit - used),
        resetsAt: nextIstMidnightIso(),
      })
    } catch (err) {
      console.error('Usage read failed:', err.message)
      return res.status(500).json({ error: { message: 'Usage check failed.' } })
    }
  })

  // Isolated builder-preview renderer. The generated app runs inside a sandboxed
  // iframe pointed here; this route ships its OWN relaxed CSP (PREVIEW_CSP) so the
  // main app's policy stays strict. Code is delivered via postMessage, never here.
  app.get('/preview', (_req, res) => {
    res.setHeader('Content-Security-Policy', PREVIEW_CSP)
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.type('html').send(PREVIEW_SHELL)
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
  validateDailyTokenLimit() // fail loud on a malformed DAILY_TOKEN_LIMIT before boot
  const collection = await getUsersCollection() // connect to the pre-created users collection; fails loud
  const repo = createUsersRepo(collection)
  const usageRepo = createUsageRepo(await getUsageCollection()) // pre-created usage collection; fails loud
  const claudeClient = new AnthropicFoundry({
    apiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY,
    baseURL: `https://${process.env.AZURE_FOUNDRY_RESOURCE_NAME}.services.ai.azure.com/anthropic`,
    apiVersion: '2023-06-01',
  })

  const app = createApp({ repo, usageRepo, claudeClient })
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
