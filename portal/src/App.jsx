import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import SandboxPage from './pages/SandboxPage'
import BuilderPage from './pages/BuilderPage'

function RequireAuth({ children }) {
  const user = localStorage.getItem('bial_user')
  return user ? children : <Navigate to="/" replace />
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/sandbox" element={<RequireAuth><SandboxPage /></RequireAuth>} />
        <Route path="/builder" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
