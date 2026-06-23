import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import DeployBar from '../DeployBar.jsx'

afterEach(cleanup)

describe('DeployBar', () => {
  it('shows "Submit for deployment" when not yet deployed', () => {
    render(<DeployBar appId="b1" onSubmit={() => {}} />)
    expect(screen.getByTestId('submit-deploy').textContent).toMatch(/Submit for deployment/i)
    expect(screen.getByText('Not deployed')).toBeTruthy()
  })

  it('reflects pending status and offers a re-submit ("Submit update")', () => {
    render(<DeployBar appId="b1" status="pending" onSubmit={() => {}} onRefresh={() => {}} />)
    expect(screen.getByText(/Pending admin review/i)).toBeTruthy()
    expect(screen.getByTestId('submit-deploy').textContent).toMatch(/Submit update/i)
  })

  it('shows the shareable /apps/:appId URL when approved', () => {
    render(<DeployBar appId="b1" status="approved" onSubmit={() => {}} onRefresh={() => {}} />)
    expect(screen.getByText(/Approved & live/i)).toBeTruthy()
    expect(screen.getByTestId('deploy-url').textContent).toBe('/apps/b1')
  })

  it('shows the rejection note when rejected', () => {
    render(<DeployBar appId="b1" status="rejected" rejectionNote="Remove the sample rows" onSubmit={() => {}} onRefresh={() => {}} />)
    expect(screen.getByText(/Changes requested/i)).toBeTruthy()
    expect(screen.getByTestId('reject-note').textContent).toMatch(/Remove the sample rows/)
  })

  it('calls onSubmit when the button is clicked, and is disabled while busy', () => {
    const onSubmit = vi.fn()
    const { rerender } = render(<DeployBar appId="b1" onSubmit={onSubmit} />)
    fireEvent.click(screen.getByTestId('submit-deploy'))
    expect(onSubmit).toHaveBeenCalledOnce()
    rerender(<DeployBar appId="b1" busy onSubmit={onSubmit} />)
    expect(screen.getByTestId('submit-deploy').disabled).toBe(true)
  })
})
