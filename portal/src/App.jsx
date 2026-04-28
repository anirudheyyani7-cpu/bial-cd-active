import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import Enterprise from './pages/Enterprise'
import TeamSpace from './pages/TeamSpace'
import Workspace from './pages/Workspace'
import SandboxPage from './pages/SandboxPage'
import BuilderPage from './pages/BuilderPage'
import DeployPage from './pages/DeployPage'
import HelpPage from './pages/HelpPage'
import AdminPage from './pages/AdminPage'

function RequireAuth({ children }) {
  const user = localStorage.getItem('bial_user')
  return user ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/enterprise" element={<RequireAuth><Enterprise /></RequireAuth>} />
        <Route path="/teamspace" element={<RequireAuth><TeamSpace /></RequireAuth>} />
        <Route path="/workspace" element={<RequireAuth><Workspace /></RequireAuth>} />
        <Route path="/workspace/sandbox" element={<RequireAuth><SandboxPage /></RequireAuth>} />
        <Route path="/workspace/builder" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        <Route path="/workspace/deploy" element={<RequireAuth><DeployPage /></RequireAuth>} />
        <Route path="/help" element={<RequireAuth><HelpPage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />
        <Route path="/sandbox" element={<Navigate to="/workspace/sandbox" replace />} />
        <Route path="/builder" element={<Navigate to="/workspace/builder" replace />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
