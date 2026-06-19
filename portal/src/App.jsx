import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import Workspace from './pages/Workspace'
import SandboxPage from './pages/SandboxPage'
import BuilderPage from './pages/BuilderPage'
import HelpPage from './pages/HelpPage'
import AdminPage from './pages/AdminPage'
import ChatPage from './pages/ChatPage'
import ConversationsPage from './pages/ConversationsPage'
import BialChatPage from './pages/BialChatPage'
import BialConversationsPage from './pages/BialConversationsPage'
import {
  isAuthenticated,
  getStoredUser,
  getRefreshToken,
  refreshAccessToken,
  clearSession,
  startCrossTabSync,
} from './utils/auth'

// Full-screen silent-refresh spinner. Reuses the app's inline-SVG animate-spin
// idiom (LoginPage) so we don't introduce a new shared component.
function AuthLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <svg className="animate-spin h-7 w-7 text-primary" viewBox="0 0 24 24" fill="none" aria-label="Loading">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
    </div>
  )
}

/**
 * Route guard. The access token is short-lived (15m); navigation makes no API
 * call, so without this guard an expired-but-refreshable session would be
 * bounced straight to /login even though a valid refresh token is on hand.
 * Instead we attempt a silent refresh before giving up:
 *   - authenticated            → render immediately (zero async, no flicker)
 *   - expired + refresh token  → refresh, showing a spinner; render on success
 *   - no refresh token         → purge any stale tokenless profile, redirect
 * A refresh that returns null but LEAVES the refresh token in place was a
 * transient network error (auth.js fails open on those) — we render children
 * and let the API layer retry, rather than logging the user out on a blip.
 */
function RequireAuth({ children }) {
  const location = useLocation()
  // 'ok' | 'refreshing' | 'redirect'. Initialized synchronously so the common
  // authenticated case renders children on first paint with no spinner frame.
  const [status, setStatus] = useState(() => {
    if (isAuthenticated()) return 'ok'
    return getRefreshToken() ? 'refreshing' : 'redirect'
  })

  // Re-evaluate on every navigation. location.key changes even for same-route
  // param changes (/chat/:a → /chat/:b) where this guard is not remounted.
  useEffect(() => {
    let cancelled = false

    if (isAuthenticated()) {
      setStatus('ok')
      return undefined
    }

    if (getRefreshToken()) {
      setStatus('refreshing')
      refreshAccessToken().then((token) => {
        if (cancelled) return
        // token → refreshed; null + refresh token still present → transient
        // network error (session preserved), render and let the API layer
        // retry; null + refresh token gone → auth rejected, redirect.
        setStatus(token || getRefreshToken() ? 'ok' : 'redirect')
      })
      return () => {
        cancelled = true
      }
    }

    // Genuinely tokenless: purge a stale profile (old mock/admin session) so it
    // can't linger, then redirect.
    if (getStoredUser()) clearSession()
    setStatus('redirect')
    return undefined
  }, [location.key])

  if (status === 'redirect') return <Navigate to="/login" replace />
  if (status === 'refreshing') return <AuthLoading />
  return children
}

export default function App() {
  // Adopt access tokens rotated by peer tabs (cross-tab session sync).
  useEffect(() => {
    const channel = startCrossTabSync()
    return () => channel?.close?.()
  }, [])

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
        {/* Enterprise Space + Team Space removed (POC dummy features) — redirect old links. */}
        <Route path="/enterprise" element={<Navigate to="/dashboard" replace />} />
        <Route path="/teamspace" element={<Navigate to="/dashboard" replace />} />
        <Route path="/workspace" element={<RequireAuth><Workspace /></RequireAuth>} />
        <Route path="/workspace/sandbox" element={<RequireAuth><SandboxPage /></RequireAuth>} />
        <Route path="/workspace/builder" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        <Route path="/workspace/builder/:buildId" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        <Route path="/workspace/chat" element={<RequireAuth><ChatPage /></RequireAuth>} />
        <Route path="/workspace/chat/:chatId" element={<RequireAuth><ChatPage /></RequireAuth>} />
        <Route path="/workspace/history" element={<RequireAuth><ConversationsPage /></RequireAuth>} />
        {/* BIAL Chat (general assistant) — sibling of App Builder, top-level /chat.
            Static /chat/history ranks above the dynamic /chat/:chatId in RR v6. */}
        <Route path="/chat" element={<RequireAuth><BialChatPage /></RequireAuth>} />
        <Route path="/chat/history" element={<RequireAuth><BialConversationsPage /></RequireAuth>} />
        <Route path="/chat/:chatId" element={<RequireAuth><BialChatPage /></RequireAuth>} />
        <Route path="/help" element={<RequireAuth><HelpPage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />
        <Route path="/sandbox" element={<Navigate to="/workspace/sandbox" replace />} />
        <Route path="/builder" element={<Navigate to="/workspace/builder" replace />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
