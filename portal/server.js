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
import { requireAuth, requireAdmin } from './server/auth/middleware.js'
import { createAuthRouter } from './server/auth/routes.js'
import { createAdminRouter } from './server/admin/routes.js'
import { validateTokenConfig } from './server/auth/tokens.js'
import { createUsersRepo } from './server/users-repo.js'
import { createUsageRepo, istDateKey, nextIstMidnightIso } from './server/usage-repo.js'
import { createFeedbackRepo } from './server/feedback-repo.js'
import { makeFeedbackLimiter, createFeedbackHandler } from './server/feedback.js'
import { createConversationsRepo } from './server/conversations-repo.js'
import { createMessagesRepo } from './server/messages-repo.js'
import { ensureIndexes } from './server/ensure-indexes.js'
import { createAttachmentsRepo } from './server/attachments-repo.js'
import { createConversationsRouter } from './server/conversations.js'
import { createAttachmentsRouter } from './server/attachments.js'
import { createAnthropicFiles } from './server/anthropic-files.js'
import { createAppRegistryRepo } from './server/app-registry-repo.js'
import { createDataRecordsRepo } from './server/data-records-repo.js'
import { createAuditRepo } from './server/audit-repo.js'
import { createAppDataRouter, makeDataServiceCors, APP_DATA_BODY_LIMIT } from './server/app-data.js'
import { createAppFilesRouter, APP_FILE_MAX_JSON } from './server/app-files.js'
import { createAppParseRouter } from './server/app-parse.js'
import { createAppFilesRepo } from './server/app-files-repo.js'
import { createDeployRouter } from './server/deploy.js'
import { createAdminAppsRouter } from './server/admin/apps-routes.js'
import { bialDataClientScript } from './server/bial-data-client.js'
import { createRunnerRouter } from './server/runner.js'
import { validateAttachments } from './server/message-content.js'
import { getObjectStore } from './server/object-store.js'
import {
  getUsersCollection,
  getUsageCollection,
  getFeedbackCollection,
  getConversationsCollection,
  getMessagesCollection,
  getAttachmentUsageCollection,
  getAppRegistryCollection,
  getDataRecordsCollection,
  getAppFilesCollection,
  getAuditCollection,
} from './server/cosmos.js'
import {
  DEFAULT_DAILY_TOKEN_LIMIT,
  DEFAULT_CONTEXT_SOFT_LIMIT,
  DEFAULT_CONTEXT_HARD_LIMIT,
  resolveUserLimits,
} from './server/limits.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST = path.join(__dirname, 'dist')

// The DAILY_TOKEN_LIMIT env sets the standard-plan daily ceiling (the default
// for users with no per-user override). Per-user overrides + resolution live in
// server/limits.js; DEFAULT_DAILY_TOKEN_LIMIT is the fallback when the env is
// unset/invalid.

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

/** The absolute origin this request was served from (for the sandboxed-frame CSPs). */
function originOf(req) {
  return `${req.protocol}://${req.get('host')}`
}

// Relaxed CSP for the ISOLATED builder-preview iframe only (served at /preview).
// The generated app needs CDN React/Babel/Tailwind + inline eval (Babel compiles
// JSX at runtime). Scoping this to its own route keeps the main app's CSP strict.
// The preview runs sandboxed WITHOUT allow-same-origin → OPAQUE origin, so its
// data fetch to the portal is cross-origin: `connect-src` must list the portal
// ORIGIN explicitly ('self' = the opaque origin, which matches nothing), scoped
// to exactly the Data-Service origin (no wildcard egress) per Decision 8.
function buildPreviewCsp(origin) {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    // blob: lets the preview render a stored file inline via fetch('/content')→
    // createObjectURL→<img src=blob:> (an in-frame url, no outward egress). Still NO
    // bare https: AND NO portal origin — an <img> beacon to an arbitrary https host (or
    // the portal origin) would exfiltrate the injected token past the scoped connect-src
    // (matches the runner frame, Decisions 3, 8).
    "img-src 'self' data: blob:",
    // CDNs load as <script>/<style> (covered above) and are never fetch targets,
    // so connect-src stays scoped to the Data-Service origin — no off-origin XHR
    // egress for the injected access token (matches the runner frame, Decision 8).
    `connect-src 'self' ${origin}`,
    "frame-ancestors 'self'", // so the same-origin SPA can frame this renderer
    // allow-forms (preview iframe) lets the app's onSubmit handlers fire; native form
    // navigation is blocked here so the injected token can't be POSTed off-origin.
    "form-action 'none'",
  ].join('; ')
}

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
<!-- Sanctioned chart library (R6): Recharts as a global. Its UMD externalises React
     + PropTypes, so prop-types loads first. Both ride the existing unpkg script-src
     allowlist (no CSP change); Recharts renders SVG in-DOM, so img-src stays locked. -->
<script src="https://unpkg.com/prop-types@15.8.1/prop-types.min.js"></script>
<script src="https://unpkg.com/recharts@2.15.4/umd/Recharts.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{primary:'#00818A',secondary:'#D9A036',tertiary:'#1A2B34'},fontFamily:{manrope:['Manrope','sans-serif']}}}}</script>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>body{margin:0;font-family:'Manrope',sans-serif;background:#fff;}</style>
</head><body>
<div id="root"></div>
<script>${bialDataClientScript()}</script>
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
    if (!e.data) return;
    // Data wiring + token are injected via postMessage (this frame is opaque-origin
    // and cannot read the portal's localStorage). BIALData reads these globals.
    if (e.data.config) window.__BIAL_CONFIG = e.data.config;
    if ('accessToken' in e.data) window.__BIAL_TOKEN = e.data.accessToken || null;
    if ('user' in e.data) window.__BIAL_USER = e.data.user || null; // so currentUser() works in preview too
    if (typeof e.data.previewCode === 'string') renderPreview(e.data.previewCode);
  });
  if (window.parent) window.parent.postMessage({ previewReady: true }, '*');
</script>
</body></html>`

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
  feedbackRepo,
  conversationsRepo,
  messagesRepo,
  attachmentsRepo,
  registryRepo,
  dataRecordsRepo,
  appFilesRepo,
  auditRepo,
  objectStore,
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

  // Scoped CORS for the Data Service, registered BEFORE the global SPA cors so the
  // sandboxed opaque-origin iframe (Origin: null) preflight is answered with the
  // right headers (the global allowlist cors would otherwise short-circuit the
  // OPTIONS with no ACAO). Header-auth only, no cookies → no ambient authority.
  app.use('/api/apps', makeDataServiceCors())
  // Dev convenience only: the Vite origin. Single-origin prod needs no CORS.
  app.use(cors({ origin: ['http://localhost:5173'] }))
  // /api/claude carries base64 attachment blocks, so it needs a large body limit;
  // every OTHER route keeps the tight 100 KB default. Registering the route-
  // specific parser FIRST means it consumes the /api/claude body, after which the
  // global parser's `req._body` guard makes it no-op for that path.
  app.use('/api/claude', express.json({ limit: '35mb' }))
  // /api/attachments uploads one base64 image/PDF per request; a 4 MB binary is
  // ≈5.5 MB base64, so a 6 MB cap fits one file (NOT the 35 MB /api/claude ceiling).
  app.use('/api/attachments', express.json({ limit: '6mb' }))
  // Message-persist bodies carry parts[]; an inline csv/txt attachment can be a
  // ~512 KB text part (TEXT_BLOCK_MAX_CHARS), and a builder code snapshot is sizable
  // — both exceed the 100 KB default, so /api/conversations gets a 2 MB cap.
  app.use('/api/conversations', express.json({ limit: '2mb' }))
  // Per-app FILE uploads carry one base64 file per request (~25 MB to fit an ~18 MB
  // decoded file). body-parser consumes ONCE at first match, so this /files carve-out
  // MUST precede the broad 256 KB /api/apps parser below (which also matches /files) —
  // otherwise every real upload 413s before this parser runs. Mirrors the /api/claude
  // 35 MB + /api/attachments 6 MB carve-outs above.
  app.use('/api/apps/:appId/files', express.json({ limit: APP_FILE_MAX_JSON }))
  // Per-app PARSE carries one base64 file per request (inline view-only parse), so it
  // needs the same ~25 MB carve-out as /files and MUST also precede the broad 256 KB
  // /api/apps parser below (body-parser consumes once at first match).
  app.use('/api/apps/:appId/parse', express.json({ limit: APP_FILE_MAX_JSON }))
  // Data Service records carry one small JSON record per request; a 256kb cap
  // (over the global 100 KB default) fits a generous record. Registered before
  // the global parser so it consumes the /api/apps body first.
  app.use('/api/apps', express.json({ limit: APP_DATA_BODY_LIMIT }))
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
  // feedbackRepo backs both the submit endpoint and the admin read; same
  // fail-loud stance — a missing dep must surface at boot, not as a silent 404.
  if (!feedbackRepo) throw new Error('createApp: feedbackRepo is required')
  // Persistence repos back the chats/images/code routes. Same fail-loud stance:
  // a missing dep would make the persistence routes silently 404 (the SPA
  // fallback would answer index.html and the client's res.json() would throw), so
  // surface it at boot. start() always wires them with real collections.
  if (!conversationsRepo) throw new Error('createApp: conversationsRepo is required')
  if (!messagesRepo) throw new Error('createApp: messagesRepo is required')
  if (!attachmentsRepo) throw new Error('createApp: attachmentsRepo is required')
  // Dynamic app data service: the registry, the schemaless record store, and the
  // audit trail back /api/apps/* (and the deploy/admin/runner surfaces). Same
  // fail-loud stance — a missing dep would make the data routes silently 404
  // (the SPA fallback would answer index.html and the client's res.json() would
  // throw), so surface it at boot. Appended AFTER the existing deps so the prior
  // fail-loud assertions still match. start() always wires real collections.
  if (!registryRepo) throw new Error('createApp: registryRepo is required')
  if (!dataRecordsRepo) throw new Error('createApp: dataRecordsRepo is required')
  if (!auditRepo) throw new Error('createApp: auditRepo is required')
  // Per-app file storage: the file-metadata repo + the object store (the BYTES seam).
  // objectStore is a NEW createApp dependency — it was previously built only inside
  // start() for the attachments repo; the files router AND the admin router both need
  // it now. Appended AFTER the existing deps so the prior fail-loud assertions still
  // match; a missing dep must surface at boot, not as a silent 404 / runtime TypeError.
  if (!appFilesRepo) throw new Error('createApp: appFilesRepo is required')
  if (!objectStore) throw new Error('createApp: objectStore is required')

  // The standard plan: the injected daily ceiling (env-driven) + the fixed
  // context thresholds. Per-user overrides resolve on top of this.
  const defaults = {
    dailyTokenLimit,
    contextSoftLimit: DEFAULT_CONTEXT_SOFT_LIMIT,
    contextHardLimit: DEFAULT_CONTEXT_HARD_LIMIT,
  }

  // Resolve a user's effective limits by username. A user point-read failure
  // (token valid but DB blip / user deleted) falls back to the standard plan
  // rather than locking the user out of an enforcement path on an infra hiccup.
  const limitsFor = async (username) => {
    try {
      return resolveUserLimits(await repo.findByUsername(username), defaults)
    } catch (err) {
      console.error('User limit read failed; using defaults:', err.message)
      return resolveUserLimits(null, defaults)
    }
  }

  app.use('/api/auth', createAuthRouter({ repo, defaults }))
  // Admin-only App Registry: approve/reject (U8) + list/toggle/disable/clear-data/
  // delete/audit (U10). Mounted BEFORE the broader /api/admin so its specific
  // prefix matches first (no double-auth). Gated at the mount; handlers assume admin.
  app.use(
    '/api/admin/apps',
    requireAuth,
    requireAdmin,
    createAdminAppsRouter({ registryRepo, auditRepo, dataRecordsRepo, appFilesRepo, objectStore }),
  )
  // Admin-only per-user limit management + feedback read. Gated at the mount point.
  app.use('/api/admin', requireAuth, requireAdmin, createAdminRouter({ repo, feedbackRepo, defaults }))

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

    // Per-user daily limit (standard plan unless the user has an override).
    const { dailyTokenLimit: userDailyLimit } = await limitsFor(username)

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
    if (used >= userDailyLimit) {
      return res.status(429).json({
        error: {
          message: `You've reached your daily limit of ${userDailyLimit.toLocaleString('en-US')} tokens. It resets at midnight IST. If you need a higher limit, please contact your administrator to enable a higher plan.`,
          code: 'daily_token_limit_exceeded',
          limit: userDailyLimit,
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
      const { dailyTokenLimit: userDailyLimit } = await limitsFor(req.user.sub)
      const doc = await usageRepo.getUsage(req.user.sub, istDateKey())
      const used = (doc?.inputTokens ?? 0) + (doc?.outputTokens ?? 0)
      return res.json({
        used,
        limit: userDailyLimit,
        remaining: Math.max(0, userDailyLimit - used),
        resetsAt: nextIstMidnightIso(),
      })
    } catch (err) {
      console.error('Usage read failed:', err.message)
      return res.status(500).json({ error: { message: 'Usage check failed.' } })
    }
  })

  // Authenticated feedback submit. requireAuth guarantees req.user before the
  // limiter keys on it; the limiter is per-user+IP (BIAL shares one egress IP).
  // The handler takes the author from the verified token, never the body.
  app.post('/api/feedback', requireAuth, makeFeedbackLimiter(), createFeedbackHandler(feedbackRepo))

  // Per-user persistence: conversations + messages (chats/builder) and attachment
  // bytes. Gated at the mount point; every handler scopes by req.user.sub.
  app.use('/api/conversations', requireAuth, createConversationsRouter({ conversationsRepo, messagesRepo, attachmentsRepo }))
  // Deck (.pptx) ingest uploads the derived PDF to the Anthropic Files API through
  // the same Foundry client used for the chat relay. createAnthropicFiles(null)
  // degrades gracefully (503 when called) if the client isn't configured.
  const anthropicFiles = createAnthropicFiles(claudeClient)
  app.use('/api/attachments', requireAuth, createAttachmentsRouter({ attachmentsRepo, anthropicFiles }))

  // Dynamic app data service: the shared, schemaless per-app record store every
  // generated CRUD app calls. NO global requireAuth here — the router owns its own
  // auth chain (requireAppKey → requireLoginIfRequired → per-app limiter), so an
  // open app admits anonymous writes while a login app reuses the portal token.
  app.use('/api/apps/:appId/records', createAppDataRouter({ registryRepo, dataRecordsRepo, auditRepo }))

  // Per-app FILE storage (proxy upload, SAS download, hardened content proxy). Mounted
  // BEFORE the /api/apps deploy catch-all so /files is never shadowed (exactly as the
  // records router is). Owns its own auth chain (requireAppKey → requireLoginIfRequired
  // → per-app limiter); the bytes ride the injected objectStore.
  app.use('/api/apps/:appId/files', createAppFilesRouter({ appFilesRepo, auditRepo, registryRepo, objectStore }))

  // Per-app file PARSING (Excel/CSV→rows, Word→text) for generated-app dashboards.
  // Mounted BEFORE the /api/apps deploy catch-all (like /records and /files) so it is
  // never shadowed; owns the same auth chain and runs the parse in a time-bounded worker.
  app.use('/api/apps/:appId/parse', createAppParseRouter({ appFilesRepo, registryRepo, objectStore }))

  // Deploy lifecycle (owner-facing provision + submit). Mounted at /api/apps AFTER
  // the records router (more specific) so /api/apps/:id/records is never shadowed;
  // each route applies the shared requireAuth itself (so it does NOT gate the
  // anonymous-friendly records router). Ownership is the build conversation's.
  app.use('/api/apps', createDeployRouter({ registryRepo, conversationsRepo, auditRepo }))

  // Isolated builder-preview renderer. The generated app runs inside a sandboxed
  // iframe pointed here; this route ships its OWN relaxed CSP (PREVIEW_CSP) so the
  // main app's policy stays strict. Code is delivered via postMessage, never here.
  app.get('/preview', (req, res) => {
    res.setHeader('Content-Security-Policy', buildPreviewCsp(originOf(req)))
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.type('html').send(PREVIEW_SHELL)
  })

  // Hosted-app runner: the deployed app at /apps/:appId (same-origin shell) + its
  // sandboxed opaque-origin frame at /apps/:appId/frame. Mounted BEFORE the SPA
  // static + history fallback so /apps/* serves the runner, not index.html.
  app.use('/apps', createRunnerRouter({ registryRepo }))

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
  const feedbackRepo = createFeedbackRepo(await getFeedbackCollection()) // pre-created feedback collection; fails loud
  // Persistence: pre-created collections + the object store; each fails loud on a
  // missing env var. Bytes live in the object store, never the metadata DB.
  const conversationsRepo = createConversationsRepo(await getConversationsCollection())
  const messagesRepo = createMessagesRepo(await getMessagesCollection())
  // The object store is now a SHARED dependency: the attachments repo, the files
  // router, and the admin router all use it. Build it once and thread it through.
  const objectStore = getObjectStore()
  const attachmentsRepo = createAttachmentsRepo(objectStore, await getAttachmentUsageCollection())
  // Dynamic app data service: registry, schemaless record store, file metadata, audit.
  // The data-records + files repos take the registry repo for the atomic quota counters.
  const registryRepo = createAppRegistryRepo(await getAppRegistryCollection())
  const dataRecordsCollection = await getDataRecordsCollection()
  const dataRecordsRepo = createDataRecordsRepo(dataRecordsCollection, registryRepo)
  const appFilesCollection = await getAppFilesCollection()
  const appFilesRepo = createAppFilesRepo(appFilesCollection, registryRepo)
  const auditRepo = createAuditRepo(await getAuditCollection())
  // Cosmos for MongoDB needs composite indexes to serve our filter+sort reads
  // (it 400s otherwise — see ensure-indexes.js). Idempotent + resilient, so it's
  // safe on every boot; the getters return the same cached handles. Awaited so the
  // build is kicked off before the first request, but a per-index failure only logs.
  await ensureIndexes({
    conversations: await getConversationsCollection(),
    messages: await getMessagesCollection(),
    feedback: await getFeedbackCollection(),
    dataRecords: dataRecordsCollection,
    appFiles: appFilesCollection,
  })
  const claudeClient = new AnthropicFoundry({
    apiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY,
    baseURL: `https://${process.env.AZURE_FOUNDRY_RESOURCE_NAME}.services.ai.azure.com/anthropic`,
    apiVersion: '2023-06-01',
  })

  const app = createApp({ repo, usageRepo, feedbackRepo, conversationsRepo, messagesRepo, attachmentsRepo, registryRepo, dataRecordsRepo, appFilesRepo, auditRepo, objectStore, claudeClient })
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
