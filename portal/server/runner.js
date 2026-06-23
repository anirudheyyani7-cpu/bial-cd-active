/**
 * Hosted-app runner — serves an APPROVED app at `/apps/:appId` (Decisions 4, 8).
 *
 * Two routes, mirroring the /preview model but HARDENED for a deployed, token-
 * bearing context:
 *
 *  - `GET /apps/:appId`        — a thin SAME-ORIGIN shell. It can read the portal
 *    session (for login apps) or render a login box; it embeds the app in a
 *    sandboxed iframe and injects { config, accessToken } via postMessage. Only
 *    the short-lived ACCESS token is ever injected — the 7-day refresh token is
 *    NEVER posted to the frame (it stays in the portal origin's localStorage,
 *    which the opaque-origin frame cannot read).
 *  - `GET /apps/:appId/frame`  — the SANDBOXED, opaque-origin app frame
 *    (`sandbox="allow-scripts"`, no allow-same-origin). It loads the app's
 *    PRE-COMPILED snapshot (`code.approvedSnapshot.compiled`) as plain JS — NO
 *    runtime Babel, NO `unsafe-eval` — under a CSP whose `connect-src` is scoped
 *    to the portal/Data-Service origin (no wildcard egress). It mounts the BIALData
 *    client and renders `PreviewApp` once the config arrives.
 *
 * Serving rule: an app is reachable when it is `approved` OR `pending` AND has a
 * prior `approvedSnapshot` — so a re-submitted (now-pending) app keeps serving its
 * last approved snapshot until re-approval; draft/disabled/rejected/unknown → 404.
 */
import { Router } from 'express'
import { bialDataClientScript } from './bial-data-client.js'

const TAILWIND_CFG =
  "tailwind.config={theme:{extend:{colors:{primary:'#00818A',secondary:'#D9A036',tertiary:'#1A2B34'},fontFamily:{manrope:['Manrope','sans-serif']}}}}"

/** The absolute origin this request was served from (for the frame's scoped CSP). */
function originOf(req) {
  return `${req.protocol}://${req.get('host')}`
}

/** True when an app is currently serve-able (and has a snapshot to serve). */
function isServeable(app) {
  return (
    app &&
    (app.status === 'approved' || app.status === 'pending') &&
    typeof app.code?.approvedSnapshot?.compiled === 'string'
  )
}

// Shell CSP: a normal same-origin page (login form + postMessage). No CDN/eval.
function buildShellCsp() {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'", // login/refresh are same-origin
    "frame-src 'self'", // embeds the same-origin (but sandboxed) app frame
    "frame-ancestors 'self'",
  ].join('; ')
}

// Frame CSP: pre-compiled JS, so NO 'unsafe-eval' and NO @babel/standalone. The
// opaque-origin frame's data fetch is cross-origin, so connect-src names the
// portal origin explicitly ('self' = the opaque origin, matching nothing),
// scoped to EXACTLY the Data-Service origin per Decision 8. The CDNs load as
// <script>/<style> (script-src/style-src) and are never fetch targets, so they
// are deliberately ABSENT from connect-src — a token-bearing sandbox must not
// have an off-origin XHR/beacon egress path it doesn't need.
function buildFrameCsp(origin) {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    `connect-src 'self' ${origin}`,
    "frame-ancestors 'self'", // only the same-origin shell may frame it
  ].join('; ')
}

/** The same-origin shell page: auth gate + sandboxed app frame + token injection. */
function renderShell({ appId, config }) {
  const cfgJson = JSON.stringify(config)
  const frameSrc = JSON.stringify(`/apps/${appId}/frame`)
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
  html,body{margin:0;height:100%;font-family:'Manrope',sans-serif;background:#fff;}
  #appwrap{height:100vh;}
  .hidden{display:none!important;}
  #login{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f5f7;}
  #login form{background:#fff;padding:28px;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.08);width:320px;}
  #login h1{font-size:18px;margin:0 0 4px;color:#1A2B34;}
  #login p.sub{font-size:13px;color:#667;margin:0 0 18px;}
  #login input{width:100%;box-sizing:border-box;padding:10px 12px;margin:6px 0;border:1px solid #d8dee3;border-radius:8px;font-size:14px;}
  #login button{width:100%;padding:10px;margin-top:10px;background:#00818A;color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer;}
  #err{color:#b91c1c;font-size:13px;min-height:16px;margin:8px 0 0;}
</style>
</head><body>
<div id="login" class="hidden">
  <form id="loginForm">
    <h1>Sign in</h1>
    <p class="sub">This app requires your BIAL portal sign-in.</p>
    <input id="u" placeholder="Username" autocomplete="username" />
    <input id="p" type="password" placeholder="Password" autocomplete="current-password" />
    <button type="submit">Sign in</button>
    <p id="err"></p>
  </form>
</div>
<div id="appwrap"></div>
<script>
  var CONFIG = ${cfgJson};
  var ACCESS_KEY='bial_access_token', REFRESH_KEY='bial_refresh_token', USER_KEY='bial_user';
  var frame = null, accessToken = null;

  function decodeExp(t){ try{ var b=atob(String(t).split('.')[1].replace(/-/g,'+').replace(/_/g,'/')); return (JSON.parse(b).exp||0)*1000; }catch(e){ return 0; } }
  function validAccess(){ var t=localStorage.getItem(ACCESS_KEY); return (t && decodeExp(t) > Date.now()) ? t : null; }

  function showApp(){
    document.getElementById('login').classList.add('hidden');
    if (frame) { postToFrame(); return; }
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox','allow-scripts');
    frame.src = ${frameSrc};
    frame.title = 'App';
    frame.style.cssText = 'width:100%;height:100vh;border:0;display:block;';
    document.getElementById('appwrap').appendChild(frame);
    // runnerReady (from the frame) triggers postToFrame with the current token.
  }
  // Inject ONLY the config + the short-lived access token — never the refresh token.
  function postToFrame(){ if (frame && frame.contentWindow) frame.contentWindow.postMessage({ config: CONFIG, accessToken: accessToken }, '*'); }
  function showLogin(){ document.getElementById('login').classList.remove('hidden'); }

  function persist(d){
    if (d.accessToken) localStorage.setItem(ACCESS_KEY, d.accessToken);
    if (d.refreshToken) localStorage.setItem(REFRESH_KEY, d.refreshToken);
    if (d.user) localStorage.setItem(USER_KEY, JSON.stringify(d.user));
  }

  async function tryRefresh(){
    var rt = localStorage.getItem(REFRESH_KEY); if (!rt) return false;
    try{
      var res = await fetch('/api/auth/refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ refreshToken: rt }) });
      if (!res.ok) return false;
      var d = await res.json(); if (!d.accessToken) return false;
      persist(d); accessToken = d.accessToken; return true;
    }catch(e){ return false; }
  }

  async function init(){
    if (!CONFIG.loginRequired){ accessToken = null; showApp(); return; }
    var t = validAccess(); if (t){ accessToken = t; showApp(); return; }
    if (await tryRefresh()){ showApp(); return; }
    showLogin();
  }

  document.getElementById('loginForm').addEventListener('submit', async function(ev){
    ev.preventDefault();
    var u = document.getElementById('u').value, p = document.getElementById('p').value;
    var errEl = document.getElementById('err'); errEl.textContent = '';
    try{
      var res = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: u, password: p }) });
      if (!res.ok){ errEl.textContent = 'Incorrect username or password.'; return; }
      var d = await res.json(); persist(d); accessToken = d.accessToken; showApp(); postToFrame();
    }catch(e){ errEl.textContent = 'Sign in failed. Please try again.'; }
  });

  window.addEventListener('message', function(e){ if (e.data && e.data.runnerReady) postToFrame(); });
  init();
</script>
</body></html>`
}

/** The sandboxed, opaque-origin app frame: pre-compiled JS + BIALData, no eval. */
function renderFrame({ compiled }) {
  // Defensively neutralize a literal `</script>` inside the model code so it can't
  // break out of the inline <script>. (`<\/script>` is identical JS.)
  const safeCompiled = String(compiled).replace(/<\/script/gi, '<\\/script')
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<script>${TAILWIND_CFG}</script>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>body{margin:0;font-family:'Manrope',sans-serif;background:#fff;}</style>
</head><body>
<div id="root"></div>
<script>${bialDataClientScript()}</script>
<script>(function(){
  var {useState,useEffect,useRef,useMemo,useCallback,useReducer,useContext,Fragment}=React;
  ${safeCompiled}
  window.__PreviewApp=(typeof PreviewApp!=="undefined")?PreviewApp:null;
})();</script>
<script>
  var root = ReactDOM.createRoot(document.getElementById('root'));
  var mounted = false;
  function mount(){
    if (mounted) return; mounted = true;
    try {
      if (!window.__PreviewApp) throw new Error('App did not define a PreviewApp component.');
      root.render(React.createElement(window.__PreviewApp));
    } catch (err) {
      root.render(React.createElement('pre',
        { style: { color: '#b91c1c', padding: '16px', whiteSpace: 'pre-wrap', font: '13px monospace' } },
        'App error:\\n' + String((err && err.message) || err)));
    }
  }
  window.addEventListener('message', function (e){
    if (!e.data) return;
    if (e.data.config) window.__BIAL_CONFIG = e.data.config;
    if ('accessToken' in e.data) window.__BIAL_TOKEN = e.data.accessToken || null;
    if (e.data.config) mount(); // render once the config (and token) have arrived
  });
  if (window.parent) window.parent.postMessage({ runnerReady: true }, '*');
  // Fallback for an open app whose shell injects no token: mount even if a config
  // message is delayed, so the app is never stuck blank.
  setTimeout(mount, 1500);
</script>
</body></html>`
}

export function createRunnerRouter({ registryRepo }) {
  if (!registryRepo) throw new Error('createRunnerRouter: registryRepo is required')
  const router = Router()

  // The same-origin shell.
  router.get('/:appId', async (req, res) => {
    try {
      const app = await registryRepo.getApp(req.params.appId)
      if (!isServeable(app)) return res.status(404).type('html').send('<!doctype html><title>Not available</title><p>This app is not available.</p>')
      const config = {
        appId: app._id,
        appKey: app.appKey,
        baseUrl: '/api', // relative; the frame resolves it to the portal origin (CORS + scoped connect-src)
        loginRequired: Boolean(app.loginRequired),
      }
      res.setHeader('Content-Security-Policy', buildShellCsp())
      res.setHeader('X-Frame-Options', 'SAMEORIGIN')
      res.type('html').send(renderShell({ appId: app._id, config }))
    } catch (err) {
      console.error('runner shell error:', err.message)
      res.status(500).type('html').send('<!doctype html><title>Error</title><p>This app could not be loaded.</p>')
    }
  })

  // The sandboxed app frame (pre-compiled snapshot).
  router.get('/:appId/frame', async (req, res) => {
    try {
      const app = await registryRepo.getApp(req.params.appId)
      if (!isServeable(app)) return res.status(404).type('html').send('<!doctype html><title>Not available</title>')
      res.setHeader('Content-Security-Policy', buildFrameCsp(originOf(req)))
      res.setHeader('X-Frame-Options', 'SAMEORIGIN')
      res.type('html').send(renderFrame({ compiled: app.code.approvedSnapshot.compiled }))
    } catch (err) {
      console.error('runner frame error:', err.message)
      res.status(500).type('html').send('<!doctype html><title>Error</title>')
    }
  })

  return router
}
