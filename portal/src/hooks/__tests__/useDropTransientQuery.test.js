/**
 * The transient-query drop, and the hand-off it must NOT carry forward (N1).
 *
 * `window.history.replaceState` rewrites history but emits no popstate, so react-router's
 * in-memory `location.state` survives it. This hook then wrote that surviving hand-off straight
 * back into history via `navigate(path, { replace: true, state: current.state })` — so one
 * reload later the prompt was still there, the fire-once ref had died with the mount, and the
 * opening turn ran a second time, billed twice against a thread the user was only re-reading.
 *
 * It fires on exactly the FIRST reload and never again (the second has no query left to drop),
 * which is precisely the shape a naive test passes for the wrong reason.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDropTransientQuery } from '../useDropTransientQuery'

const navigate = vi.fn()
let currentLocation = {}

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => currentLocation,
}))

/** Mount the hook over a given URL + router state, and hand back its drop function. */
function mountAt({ pathname, search = '', state = null }) {
  navigate.mockClear()
  currentLocation = { pathname, search, state }
  return renderHook(() => useDropTransientQuery()).result.current
}

const HANDOFF = { prompt: 'a visitor log app', mode: 'plan', pendingAttachments: [] }

describe('useDropTransientQuery', () => {
  it('THE BUG: the dropped entry carries no hand-off prompt', () => {
    const drop = mountAt({ pathname: '/chat/c1', search: '?projectId=p1&kind=build', state: HANDOFF })
    drop('c1')

    expect(navigate).toHaveBeenCalledTimes(1)
    const [path, options] = navigate.mock.calls[0]
    expect(path).toBe('/chat/c1')
    expect(options.replace).toBe(true)
    // The whole fix. `state: current.state` here is what re-armed the reload.
    expect(options.state?.prompt).toBeUndefined()
    expect(options.state?.pendingAttachments).toBeUndefined()
  })

  it('still does its actual job — the transient query is stripped from the address', () => {
    const drop = mountAt({ pathname: '/chat/c1', search: '?projectId=p1&kind=build', state: HANDOFF })
    drop('c1')

    const [path] = navigate.mock.calls[0]
    expect(path).not.toContain('projectId=')
    expect(path).not.toContain('kind=')
  })

  it('no-ops when there is no query to drop', () => {
    const drop = mountAt({ pathname: '/chat/c1', search: '', state: HANDOFF })
    drop('c1')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('no-ops when the user navigated away mid-await — their URL is not ours to rewrite', () => {
    // This runs AFTER the user-turn persist resolves. A navigate() built from the render-time
    // location would snap the user back to the chat they just left.
    const drop = mountAt({ pathname: '/chat/OTHER', search: '?projectId=p1', state: HANDOFF })
    drop('c1')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('drops once per chat id — the send path calls it on every turn', () => {
    const drop = mountAt({ pathname: '/chat/c1', search: '?projectId=p1&kind=build', state: HANDOFF })
    drop('c1')
    drop('c1')
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})
