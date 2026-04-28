import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/layout/Navbar'
import {
  Box, Clock, ShieldAlert, AlertTriangle, Users, RefreshCw,
  Shield, Check, Trash2, UserPlus, Info, ChevronDown, X,
  Archive, Mail, Eye, Code2, Calendar, AlertCircle,
  CheckCircle, XCircle, Lock
} from 'lucide-react'

const MOCK_ADMIN_APPS_INITIAL = [
  { id: 1, name: 'CargoTracker Pro', owner: 'Rahul M.', dept: 'Logistics', space: 'Enterprise', status: 'active', created: '2025-11-15', lastActive: '1 hour ago', users: 342 },
  { id: 2, name: 'StaffGuard ID', owner: 'Priya S.', dept: 'Security', space: 'Enterprise', status: 'active', created: '2025-09-22', lastActive: '30 min ago', users: 891 },
  { id: 3, name: 'Cab Booking for Staff', owner: 'Arjun K.', dept: 'Ground Ops', space: 'Team', status: 'active', created: '2026-01-10', lastActive: '3 hours ago', users: 67 },
  { id: 4, name: 'Terminal Wayfinding AI', owner: 'Alex Chen', dept: 'Terminal Ops', space: 'Enterprise', status: 'active', created: '2026-02-14', lastActive: '2 hours ago', users: 28 },
  { id: 5, name: 'Gate Delay Logger', owner: 'Meena R.', dept: 'Terminal Ops', space: 'Team', status: 'under_review', created: '2026-04-20', lastActive: '1 day ago', users: 23 },
  { id: 6, name: 'VIP Lounge Tracker', owner: 'Suresh B.', dept: 'Customer Service', space: 'Workspace', status: 'under_review', created: '2026-04-22', lastActive: '2 days ago', users: 3 },
  { id: 7, name: 'Runway Inspection Logger', owner: 'Dev P.', dept: 'Maintenance', space: 'Team', status: 'flagged', created: '2026-03-05', lastActive: '15 days ago', users: 8, flagReason: 'Accesses restricted airside zone data without proper clearance level' },
  { id: 8, name: 'Old Parking Counter', owner: 'Kiran L.', dept: 'Facilities', space: 'Workspace', status: 'inactive', created: '2025-06-01', lastActive: '45 days ago', users: 0 },
]

const ACTIVITY_LOG = [
  { icon: Shield, color: 'text-red-500', bg: 'bg-red-50', text: 'Security review completed for "Runway Inspection Logger" — flagged for airside data access', time: '3 hours ago' },
  { icon: Check, color: 'text-green-600', bg: 'bg-green-50', text: '"Terminal Wayfinding AI" approved for Enterprise deployment', time: '1 day ago' },
  { icon: AlertTriangle, color: 'text-amber-500', bg: 'bg-amber-50', text: '"Old Parking Counter" marked inactive (no activity for 45 days)', time: '2 days ago' },
  { icon: UserPlus, color: 'text-primary', bg: 'bg-teal-50', text: 'New developer "Meena R." onboarded to Citizen Developer portal', time: '3 days ago' },
  { icon: Trash2, color: 'text-neutral', bg: 'bg-gray-50', text: '"Test App 001" deleted by admin', time: '5 days ago' },
]

const MOCK_CODE = `// CargoTracker Pro — main.js
import { fetchCargoManifest } from './api/cargo'
import { renderDashboard } from './ui/dashboard'

async function init() {
  const manifest = await fetchCargoManifest({ terminal: 'T2' })
  renderDashboard(manifest)
}

init()`

function StatusBadge({ status }) {
  const map = {
    active: { label: 'Active', cls: 'bg-green-100 text-green-700' },
    under_review: { label: 'Under Review', cls: 'bg-amber-100 text-amber-700' },
    flagged: { label: 'Flagged', cls: 'bg-red-100 text-red-700' },
    inactive: { label: 'Inactive', cls: 'bg-gray-100 text-gray-500' },
    archived: { label: 'Archived', cls: 'bg-gray-100 text-gray-400' },
  }
  const { label, cls } = map[status] || map.inactive
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>{label}</span>
}

function SpaceBadge({ space }) {
  const map = {
    Enterprise: 'bg-teal-100 text-primary',
    Team: 'bg-blue-100 text-blue-700',
    Workspace: 'bg-purple-100 text-purple-700',
  }
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${map[space] || 'bg-gray-100 text-gray-600'}`}>{space}</span>
}

function MetricCard({ icon: Icon, label, value, accent }) {
  const accentMap = {
    amber: 'border-l-amber-400',
    red: 'border-l-red-400',
    gray: 'border-l-gray-300',
    teal: 'border-l-primary',
    none: '',
  }
  return (
    <div className={`bg-white rounded-xl border border-bial-border shadow-sm px-5 py-4 flex items-center gap-4 ${accent !== 'none' ? 'border-l-4 ' + accentMap[accent] : ''}`}>
      <div className="w-10 h-10 rounded-lg bg-bial-bg flex items-center justify-center flex-shrink-0">
        <Icon size={18} className="text-neutral" />
      </div>
      <div>
        <p className="text-2xl font-bold text-tertiary">{value}</p>
        <p className="text-xs text-neutral mt-0.5">{label}</p>
      </div>
    </div>
  )
}

function ReviewPanel({ app, onClose, onApprove, onReject }) {
  const [showReject, setShowReject] = useState(false)
  const [comment, setComment] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-lg bg-white h-full flex flex-col shadow-2xl overflow-y-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-bial-border flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-neutral">App Review</p>
            <h2 className="text-base font-bold text-tertiary mt-0.5">{app.name}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-neutral hover:text-tertiary rounded-lg hover:bg-bial-bg transition">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 px-6 py-5 space-y-5">
          {/* Meta */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Owner', value: `${app.owner} · ${app.dept}` },
              { label: 'Space', value: app.space },
              { label: 'Created', value: app.created },
              { label: 'Last Modified', value: '2 days ago' },
              { label: 'Deployment Target', value: app.space === 'Enterprise' ? 'Enterprise Cloud' : 'Team Server' },
              { label: 'Active Users', value: app.users },
            ].map(({ label, value }) => (
              <div key={label} className="bg-bial-bg rounded-lg px-3 py-2.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-neutral">{label}</p>
                <p className="text-sm font-semibold text-tertiary mt-0.5">{value}</p>
              </div>
            ))}
          </div>

          {/* Description */}
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-neutral mb-2">Description</p>
            <p className="text-sm text-tertiary leading-relaxed">
              This application was developed by {app.owner} ({app.dept}) to streamline operations within the {app.dept} department.
              It integrates with internal BIAL systems and has been submitted for {app.space} deployment approval.
            </p>
          </div>

          {/* Status badge */}
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-neutral">Current Status</p>
            <StatusBadge status={app.status} />
          </div>

          {/* Code preview */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Code2 size={13} className="text-neutral" />
              <p className="text-xs font-bold uppercase tracking-wider text-neutral">Code Preview</p>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 overflow-x-auto">
              <pre className="text-xs text-green-400 font-mono leading-relaxed whitespace-pre">{MOCK_CODE}</pre>
            </div>
          </div>

          {/* Reject textarea */}
          {showReject && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-neutral mb-2">Rejection Feedback</p>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Provide specific feedback for the developer..."
                rows={4}
                className="w-full border border-bial-border rounded-xl px-3 py-2.5 text-sm text-tertiary placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-none transition"
              />
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-bial-border flex-shrink-0 space-y-2">
          {!showReject ? (
            <div className="flex gap-3">
              <button
                onClick={() => onApprove(app)}
                className="flex-1 flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-white font-semibold py-2.5 rounded-xl transition text-sm"
              >
                <CheckCircle size={15} />
                Approve for Enterprise
              </button>
              <button
                onClick={() => setShowReject(true)}
                className="flex-1 flex items-center justify-center gap-2 border border-bial-border hover:border-red-300 hover:text-red-600 text-tertiary font-semibold py-2.5 rounded-xl transition text-sm"
              >
                <XCircle size={15} />
                Reject with Feedback
              </button>
            </div>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => onReject(app, comment)}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white font-semibold py-2.5 rounded-xl transition text-sm"
              >
                Send Rejection
              </button>
              <button
                onClick={() => { setShowReject(false); setComment('') }}
                className="px-4 border border-bial-border text-neutral hover:text-tertiary py-2.5 rounded-xl transition text-sm"
              >
                Back
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ConfirmModal({ title, message, confirmLabel, confirmCls, onConfirm, onCancel, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <h3 className="text-base font-bold text-tertiary">{title}</h3>
        <p className="text-sm text-neutral mt-2 leading-relaxed">{message}</p>
        {children}
        <div className="flex gap-3 mt-5">
          <button
            onClick={onConfirm}
            className={`flex-1 py-2.5 rounded-xl font-semibold text-sm transition ${confirmCls}`}
          >
            {confirmLabel}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl font-semibold text-sm border border-bial-border text-tertiary hover:bg-bial-bg transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function AppTable({ apps, onReview, onSuspend, onDelete, onQuickApprove, onQuickReject, showQuickActions, showFlagReason, showSelect, selected, onSelect, onSelectAll }) {
  const [openDropdown, setOpenDropdown] = useState(null)
  const dropRef = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setOpenDropdown(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (apps.length === 0) {
    return (
      <div className="text-center py-16 text-neutral text-sm">
        No apps in this category.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto" ref={dropRef}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-bial-border">
            {showSelect && (
              <th className="pb-3 pr-3 text-left">
                <input
                  type="checkbox"
                  checked={selected.length === apps.length && apps.length > 0}
                  onChange={() => onSelectAll(apps)}
                  className="accent-primary w-4 h-4"
                />
              </th>
            )}
            {showFlagReason && <th className="pb-3 pr-6 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">Flag Reason</th>}
            <th className="pb-3 pr-6 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">App Name</th>
            <th className="pb-3 pr-6 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">Owner</th>
            <th className="pb-3 pr-6 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">Space</th>
            <th className="pb-3 pr-6 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">Status</th>
            <th className="pb-3 pr-6 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">Created</th>
            <th className="pb-3 pr-6 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">Last Active</th>
            <th className="pb-3 pr-6 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">Users</th>
            <th className="pb-3 text-left text-[10px] font-bold uppercase tracking-wider text-neutral">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-bial-border">
          {apps.map((app) => (
            <tr
              key={app.id}
              className={`hover:bg-bial-bg/50 transition ${app.status === 'flagged' ? 'border-l-2 border-l-red-400' : ''}`}
            >
              {showSelect && (
                <td className="py-3 pr-3">
                  <input
                    type="checkbox"
                    checked={selected.includes(app.id)}
                    onChange={() => onSelect(app.id)}
                    className="accent-primary w-4 h-4"
                  />
                </td>
              )}
              {showFlagReason && (
                <td className="py-3 pr-6 max-w-xs">
                  <p className="text-xs text-red-600 leading-relaxed">{app.flagReason || '—'}</p>
                </td>
              )}
              <td className="py-3 pr-6">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Box size={13} className="text-primary" />
                  </div>
                  <span className="font-semibold text-tertiary whitespace-nowrap">{app.name}</span>
                </div>
              </td>
              <td className="py-3 pr-6">
                <p className="text-tertiary whitespace-nowrap">{app.owner}</p>
                <p className="text-[11px] text-neutral">{app.dept}</p>
              </td>
              <td className="py-3 pr-6">
                <SpaceBadge space={app.space} />
              </td>
              <td className="py-3 pr-6">
                <StatusBadge status={app.status} />
              </td>
              <td className="py-3 pr-6 text-neutral whitespace-nowrap">{app.created}</td>
              <td className="py-3 pr-6 text-neutral whitespace-nowrap">{app.lastActive}</td>
              <td className="py-3 pr-6 text-tertiary font-semibold">{app.users.toLocaleString()}</td>
              <td className="py-3">
                <div className="flex items-center gap-1.5">
                  {showQuickActions && (
                    <>
                      <button
                        onClick={() => onQuickApprove(app)}
                        title="Quick Approve"
                        className="p-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 transition"
                      >
                        <CheckCircle size={14} />
                      </button>
                      <button
                        onClick={() => onQuickReject(app)}
                        title="Quick Reject"
                        className="p-1.5 rounded-lg bg-red-100 text-red-600 hover:bg-red-200 transition"
                      >
                        <XCircle size={14} />
                      </button>
                    </>
                  )}
                  {/* Actions dropdown */}
                  <div className="relative">
                    <button
                      onClick={() => setOpenDropdown(openDropdown === app.id ? null : app.id)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-bial-border text-neutral hover:text-tertiary hover:bg-bial-bg transition text-xs font-medium"
                    >
                      Actions <ChevronDown size={11} />
                    </button>
                    {openDropdown === app.id && (
                      <div className="absolute right-0 top-8 w-36 bg-white rounded-xl border border-bial-border shadow-xl z-20 py-1 overflow-hidden">
                        <button
                          onClick={() => { setOpenDropdown(null); onReview(app) }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-tertiary hover:bg-bial-bg transition"
                        >
                          <Eye size={13} className="text-primary flex-shrink-0" />
                          Review
                        </button>
                        <button
                          onClick={() => { setOpenDropdown(null); onSuspend(app) }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-tertiary hover:bg-bial-bg transition"
                        >
                          <AlertCircle size={13} className="text-amber-500 flex-shrink-0" />
                          Suspend
                        </button>
                        <button
                          onClick={() => { setOpenDropdown(null); onDelete(app) }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition"
                        >
                          <Trash2 size={13} className="flex-shrink-0" />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AdminPage() {
  const navigate = useNavigate()
  const user = JSON.parse(localStorage.getItem('bial_user') || '{}')

  const [apps, setApps] = useState(MOCK_ADMIN_APPS_INITIAL)
  const [activeTab, setActiveTab] = useState('all')
  const [reviewApp, setReviewApp] = useState(null)
  const [suspendApp, setSuspendApp] = useState(null)
  const [deleteApp, setDeleteApp] = useState(null)
  const [toast, setToast] = useState(null)
  const [selectedInactive, setSelectedInactive] = useState([])
  const toastTimer = useRef(null)

  const showToast = (msg) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }

  const updateAppStatus = (id, status) => {
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)))
  }

  const removeApp = (id) => {
    setApps((prev) => prev.filter((a) => a.id !== id))
  }

  const handleApprove = (app) => {
    updateAppStatus(app.id, 'active')
    setReviewApp(null)
    showToast(`"${app.name}" approved for Enterprise deployment`)
  }

  const handleReject = (app, comment) => {
    updateAppStatus(app.id, 'inactive')
    setReviewApp(null)
    showToast(`Rejection sent to ${app.owner} with feedback`)
  }

  const handleQuickApprove = (app) => {
    updateAppStatus(app.id, 'active')
    showToast(`"${app.name}" approved`)
  }

  const handleQuickReject = (app) => {
    updateAppStatus(app.id, 'inactive')
    showToast(`"${app.name}" rejected`)
  }

  const handleSuspend = () => {
    updateAppStatus(suspendApp.id, 'inactive')
    setSuspendApp(null)
    showToast(`"${suspendApp.name}" suspended`)
  }

  const handleDelete = () => {
    removeApp(deleteApp.id)
    setDeleteApp(null)
    showToast(`"${deleteApp.name}" deleted`)
  }

  const handleArchiveSelected = () => {
    setApps((prev) => prev.map((a) => selectedInactive.includes(a.id) ? { ...a, status: 'archived' } : a))
    setSelectedInactive([])
    showToast('Selected apps archived')
  }

  const handleSelectInactive = (id) => {
    setSelectedInactive((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const handleSelectAllInactive = (inactiveApps) => {
    if (selectedInactive.length === inactiveApps.length) {
      setSelectedInactive([])
    } else {
      setSelectedInactive(inactiveApps.map((a) => a.id))
    }
  }

  const allApps = apps.filter((a) => a.status !== 'archived')
  const pendingApps = apps.filter((a) => a.status === 'under_review')
  const flaggedApps = apps.filter((a) => a.status === 'flagged')
  const inactiveApps = apps.filter((a) => a.status === 'inactive')

  if (!user.isAdmin) {
    return (
      <div className="min-h-screen bg-bial-bg flex flex-col font-manrope">
        <Navbar />
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <div className="w-14 h-14 rounded-2xl bg-red-100 flex items-center justify-center mx-auto mb-4">
              <Lock size={22} className="text-red-500" />
            </div>
            <h2 className="text-lg font-bold text-tertiary mb-2">Access Denied</h2>
            <p className="text-sm text-neutral leading-relaxed">
              You don't have permission to access the Admin Console. Contact IT if you believe this is an error.
            </p>
            <button
              onClick={() => navigate('/dashboard')}
              className="mt-6 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }

  const TABS = [
    { id: 'all', label: 'All Apps', count: allApps.length },
    { id: 'pending', label: 'Pending Review', count: pendingApps.length },
    { id: 'flagged', label: 'Security Flags', count: flaggedApps.length },
    { id: 'inactive', label: 'Inactive Apps', count: inactiveApps.length },
  ]

  return (
    <div className="min-h-screen bg-bial-bg flex flex-col font-manrope">
      <Navbar />

      <div className="flex-1 px-6 py-8 max-w-7xl mx-auto w-full">
        {/* Page Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-tertiary">Admin Console</h1>
            <p className="text-sm text-neutral mt-1">IT Operations Dashboard — Monitor, review, and manage all citizen-developed applications across the terminal.</p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0 ml-6">
            <p className="text-xs text-neutral hidden sm:block">Last refreshed: 2 minutes ago</p>
            <button
              onClick={() => showToast('Data refreshed')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-bial-border bg-white text-tertiary text-sm font-medium hover:bg-bial-bg transition"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </div>

        {/* Metric Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-6">
          <MetricCard icon={Box} label="Total Apps in Production" value={14} accent="none" />
          <MetricCard icon={Clock} label="Pending Review" value={3} accent="amber" />
          <MetricCard icon={ShieldAlert} label="Security Flagged" value={1} accent="red" />
          <MetricCard icon={AlertTriangle} label="Inactive 30+ Days" value={4} accent="gray" />
          <MetricCard icon={Users} label="Active Developers" value={23} accent="teal" />
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-2xl border border-bial-border shadow-sm overflow-hidden mb-6">
          {/* Tab Bar */}
          <div className="flex border-b border-bial-border px-4">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3.5 text-sm font-medium border-b-2 transition -mb-px whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'text-primary border-primary'
                    : 'text-neutral border-transparent hover:text-tertiary'
                }`}
              >
                {tab.label}
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                  activeTab === tab.id ? 'bg-primary/10 text-primary' : 'bg-gray-100 text-neutral'
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="p-4">
            {/* Inactive batch action bar */}
            {activeTab === 'inactive' && inactiveApps.length > 0 && (
              <div className="flex items-center gap-3 mb-4 p-3 bg-bial-bg rounded-xl border border-bial-border">
                <span className="text-xs text-neutral font-medium">{selectedInactive.length} selected</span>
                <button
                  onClick={handleArchiveSelected}
                  disabled={selectedInactive.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-bial-border text-sm font-medium text-tertiary hover:bg-gray-50 disabled:opacity-40 transition"
                >
                  <Archive size={13} />
                  Archive Selected
                </button>
                <button
                  onClick={() => showToast('Reminder emails sent to app owners')}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-bial-border text-sm font-medium text-tertiary hover:bg-gray-50 transition"
                >
                  <Mail size={13} />
                  Notify Owners
                </button>
              </div>
            )}

            {activeTab === 'all' && (
              <AppTable
                apps={allApps}
                onReview={setReviewApp}
                onSuspend={setSuspendApp}
                onDelete={setDeleteApp}
                showQuickActions={false}
                showFlagReason={false}
                showSelect={false}
                selected={[]}
                onSelect={() => {}}
                onSelectAll={() => {}}
              />
            )}
            {activeTab === 'pending' && (
              <AppTable
                apps={pendingApps}
                onReview={setReviewApp}
                onSuspend={setSuspendApp}
                onDelete={setDeleteApp}
                onQuickApprove={handleQuickApprove}
                onQuickReject={handleQuickReject}
                showQuickActions={true}
                showFlagReason={false}
                showSelect={false}
                selected={[]}
                onSelect={() => {}}
                onSelectAll={() => {}}
              />
            )}
            {activeTab === 'flagged' && (
              <AppTable
                apps={flaggedApps}
                onReview={setReviewApp}
                onSuspend={setSuspendApp}
                onDelete={setDeleteApp}
                showQuickActions={false}
                showFlagReason={true}
                showSelect={false}
                selected={[]}
                onSelect={() => {}}
                onSelectAll={() => {}}
              />
            )}
            {activeTab === 'inactive' && (
              <AppTable
                apps={inactiveApps}
                onReview={setReviewApp}
                onSuspend={setSuspendApp}
                onDelete={setDeleteApp}
                showQuickActions={false}
                showFlagReason={false}
                showSelect={true}
                selected={selectedInactive}
                onSelect={handleSelectInactive}
                onSelectAll={handleSelectAllInactive}
              />
            )}
          </div>
        </div>

        {/* Activity Log */}
        <div className="bg-white rounded-2xl border border-bial-border shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-tertiary">Admin Activity Log</h2>
            <button
              onClick={() => showToast('Full audit log coming soon')}
              className="text-xs text-primary font-semibold hover:underline"
            >
              View Full Log
            </button>
          </div>
          <div className="space-y-3">
            {ACTIVITY_LOG.map((entry, i) => {
              const Icon = entry.icon
              return (
                <div key={i} className="flex items-start gap-3">
                  <div className={`w-7 h-7 rounded-lg ${entry.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                    <Icon size={13} className={entry.color} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-tertiary leading-relaxed">{entry.text}</p>
                    <p className="text-xs text-neutral mt-0.5">{entry.time}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Review Slide-out */}
      {reviewApp && (
        <ReviewPanel
          app={reviewApp}
          onClose={() => setReviewApp(null)}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {/* Suspend Modal */}
      {suspendApp && (
        <ConfirmModal
          title={`Suspend "${suspendApp.name}"?`}
          message="This will immediately make the app unavailable to all users."
          confirmLabel="Suspend App"
          confirmCls="bg-amber-500 hover:bg-amber-600 text-white"
          onConfirm={handleSuspend}
          onCancel={() => setSuspendApp(null)}
        />
      )}

      {/* Delete Modal */}
      {deleteApp && (
        <ConfirmModal
          title={`Permanently delete "${deleteApp.name}"?`}
          message="This action cannot be undone. All user data associated with this app will be lost."
          confirmLabel="Delete Permanently"
          confirmCls="bg-red-600 hover:bg-red-700 text-white"
          onConfirm={handleDelete}
          onCancel={() => setDeleteApp(null)}
        >
          <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
            <AlertCircle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-600">Warning: {deleteApp.users} users will lose access immediately.</p>
          </div>
        </ConfirmModal>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-white border border-bial-border rounded-xl shadow-xl px-4 py-3 text-sm text-tertiary font-medium flex items-center gap-2">
          <Info size={14} className="text-primary flex-shrink-0" />
          {toast}
        </div>
      )}
    </div>
  )
}
