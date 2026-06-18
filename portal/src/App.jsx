import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import Workspace from './pages/Workspace'
import SandboxPage from './pages/SandboxPage'
import BuilderPage from './pages/BuilderPage'
import DeployPage from './pages/DeployPage'
import HelpPage from './pages/HelpPage'
import AdminPage from './pages/AdminPage'
import ChatPage from './pages/ChatPage'
import ConversationsPage from './pages/ConversationsPage'
import { isAuthenticated, getStoredUser, clearSession, startCrossTabSync } from './utils/auth'

function RequireAuth({ children }) {
  if (!isAuthenticated()) {
    // Boot-time purge: a stale tokenless profile (e.g. an old mock/admin
    // session from before this deploy) is cleared so it can't linger.
    if (getStoredUser()) clearSession()
    return <Navigate to="/login" replace />
  }
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
        <Route path="/workspace/deploy" element={<RequireAuth><DeployPage /></RequireAuth>} />
        <Route path="/workspace/chat" element={<RequireAuth><ChatPage /></RequireAuth>} />
        <Route path="/workspace/chat/:chatId" element={<RequireAuth><ChatPage /></RequireAuth>} />
        <Route path="/workspace/history" element={<RequireAuth><ConversationsPage /></RequireAuth>} />
        <Route path="/help" element={<RequireAuth><HelpPage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />
        <Route path="/sandbox" element={<Navigate to="/workspace/sandbox" replace />} />
        <Route path="/builder" element={<Navigate to="/workspace/builder" replace />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
