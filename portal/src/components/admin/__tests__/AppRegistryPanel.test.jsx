import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import AppRegistryPanel from '../AppRegistryPanel.jsx'

const h = vi.hoisted(() => ({
  listApps: vi.fn(),
  approveApp: vi.fn(),
  rejectApp: vi.fn(),
  patchApp: vi.fn(),
  disableApp: vi.fn(),
  enableApp: vi.fn(),
  dataSummary: vi.fn(),
  clearData: vi.fn(),
  deleteApp: vi.fn(),
  fetchAudit: vi.fn(),
  recomputeFiles: vi.fn(),
}))
vi.mock('../../../utils/appRegistryApi', () => h)

const PENDING = {
  appId: 'app-1',
  name: 'Gate Tool',
  ownerUsername: 'alice',
  status: 'pending',
  loginRequired: false,
  dataCount: 0,
  dataBytes: 0,
  fileCount: 2,
  fileBytes: 4096,
  hasApprovedSnapshot: false,
}

afterEach(cleanup)
beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.listApps.mockResolvedValue([PENDING])
})

describe('AppRegistryPanel — registry vocabulary + actions', () => {
  it('loads the pending list and renders the registry status sub-tabs (not the mock vocabulary)', async () => {
    render(<AppRegistryPanel onToast={() => {}} />)
    await screen.findByText('Gate Tool')
    expect(h.listApps).toHaveBeenCalledWith('pending')
    // registry sub-tabs exist; the mock "Security Flags"/"under_review" vocabulary does not
    expect(screen.getByTestId('apps-tab-approved')).toBeTruthy()
    expect(screen.getByTestId('apps-tab-disabled')).toBeTruthy()
    expect(screen.queryByText('Security Flags')).toBeNull()
    expect(screen.getAllByText('Pending Review').length).toBeGreaterThan(0) // tab + badge
  })

  it('Review → Approve calls approveApp and reloads', async () => {
    h.approveApp.mockResolvedValue({ status: 'approved' })
    render(<AppRegistryPanel onToast={() => {}} />)
    await screen.findByText('Gate Tool')
    fireEvent.click(screen.getByTestId('review-app-1'))
    fireEvent.click(screen.getByTestId('approve-btn'))
    await waitFor(() => expect(h.approveApp).toHaveBeenCalledWith('app-1'))
    await waitFor(() => expect(h.listApps).toHaveBeenCalledTimes(2)) // initial + reload
  })

  it('toggling login PATCHes the inverse loginRequired', async () => {
    h.patchApp.mockResolvedValue({})
    render(<AppRegistryPanel onToast={() => {}} />)
    await screen.findByText('Gate Tool')
    fireEvent.click(screen.getByRole('button', { name: /Off/i }))
    await waitFor(() => expect(h.patchApp).toHaveBeenCalledWith('app-1', { loginRequired: true }))
  })

  it('clear-data opens the two-step modal and runs only after the preflight token', async () => {
    h.dataSummary.mockResolvedValue({ dataCount: 3, dataBytes: 300, fileCount: 2, fileBytes: 4096, confirmToken: 'tok-1' })
    h.clearData.mockResolvedValue({ removed: 3, filesRemoved: 2 })
    render(<AppRegistryPanel onToast={() => {}} />)
    await screen.findByText('Gate Tool')
    fireEvent.click(screen.getByTitle('Clear data & files'))
    await screen.findByTestId('clear-confirm')
    fireEvent.click(screen.getByTestId('clear-confirm'))
    await waitFor(() => expect(h.clearData).toHaveBeenCalledWith('app-1', 'tok-1', true))
  })

  it('renders per-app file usage alongside the record quota (Files column)', async () => {
    render(<AppRegistryPanel onToast={() => {}} />)
    await screen.findByText('Gate Tool')
    expect(screen.getByText('Files')).toBeTruthy() // column header
    expect(screen.getByText(/2 · 4\.0 KB/)).toBeTruthy() // fileCount · fmtBytes(fileBytes)
  })

  it('recompute action calls recomputeFiles and reloads', async () => {
    h.recomputeFiles.mockResolvedValue({ fileCount: 2, fileBytes: 4096, sweptPending: 0 })
    render(<AppRegistryPanel onToast={() => {}} />)
    await screen.findByText('Gate Tool')
    fireEvent.click(screen.getByTestId('recompute-app-1'))
    await waitFor(() => expect(h.recomputeFiles).toHaveBeenCalledWith('app-1'))
    await waitFor(() => expect(h.listApps).toHaveBeenCalledTimes(2)) // initial + reload
  })
})
