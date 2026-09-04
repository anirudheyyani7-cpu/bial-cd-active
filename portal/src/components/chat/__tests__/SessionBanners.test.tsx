/**
 * The two lifecycle banners rendered above the composer. What is pinned here:
 *  - feed-disconnected offers a manual Reconnect;
 *  - quota shows the daily-limit + IST reset copy;
 *  - both report something BLOCKED or BROKEN and are assertive: the operator must not miss one.
 *
 * Two other banners and their tests went with their producers, so the rest is a retirement guard:
 * no lifecycle state this component can be given renders a Force-end control. That the live 409
 * arms cannot put the block banner back on screen is pinned separately, in
 * `pages/__tests__/relaunch-chain-retired.test.jsx`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import SessionBanners from '../SessionBanners'

afterEach(cleanup)

const noop = () => {}

function draw(props: Partial<Parameters<typeof SessionBanners>[0]> = {}) {
  return render(
    <SessionBanners feedDisconnected={false} quota={null} onReconnect={noop} {...props} />,
  )
}

describe('SessionBanners', () => {
  it('renders nothing when the session lifecycle is quiet', () => {
    const { container } = draw()
    expect(container.firstChild).toBeNull()
  })

  it('RETIREMENT GUARD: no state this component accepts puts a block banner or a Force-end back', () => {
    // Driven over every combination the props still allow, and PAIRED WITH LIVENESS in each: an
    // absence assertion on a component that rendered nothing is worth nothing.
    for (const props of [
      { feedDisconnected: true },
      { quota: { limit: 10, used: 11, resetsAt: '2026-07-24T00:00:00+05:30' } },
      { feedDisconnected: true, quota: { limit: 10, used: 11, resetsAt: '2026-07-24T00:00:00+05:30' } },
    ]) {
      const { unmount } = draw(props)
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0) // liveness: it rendered
      expect(screen.queryByText(/already have a build running/i)).toBeNull()
      expect(screen.queryByRole('button', { name: /force-end/i })).toBeNull()
      unmount()
    }
  })

  it('feed-disconnected banner offers a manual Reconnect', () => {
    const onReconnect = vi.fn()
    draw({ feedDisconnected: true, onReconnect })
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('quota banner shows the daily-limit + IST reset copy, assertively', () => {
    draw({ quota: { limit: 1000000, used: 1000001, resetsAt: '2026-07-24T00:00:00+05:30' } })
    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('aria-live')).toBe('assertive')
    expect(alert.textContent).toMatch(/daily limit/i)
    expect(alert.textContent).toMatch(/midnight IST/i)
  })
})
