import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LoginPage from '../LoginPage'
import { LOGIN_URL } from '../../utils/auth'

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LoginPage />
    </MemoryRouter>,
  )
}

// Navbar's handleLogout hands this exact shape to `navigate('/login', { state })` on a failed
// revoke; a real in-SPA `initialEntries` array entry (not a path string) is how MemoryRouter
// seeds that router state without going through Navbar. `pathname`/`search` are split out so
// a query string in `path` still reaches `useSearchParams()`.
function renderAtWithState(path, state) {
  const [pathname, search = ''] = path.split('?')
  return render(
    <MemoryRouter initialEntries={[{ pathname, search: search ? `?${search}` : '', state }]}>
      <LoginPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('LoginPage — Entra "Sign in with Microsoft" only', () => {
  it('renders the Microsoft sign-in action and NO password/email fields', () => {
    renderAt('/login')
    expect(screen.getByTestId('login-microsoft')).toBeTruthy()
    expect(screen.getByTestId('login-microsoft').textContent).toContain('Sign in with Microsoft')
    expect(screen.queryByTestId('login-password')).toBeNull()
    expect(screen.queryByTestId('login-email')).toBeNull()
  })

  it('full-page-navigates to the FastAPI /auth/login on click', () => {
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } })
    renderAt('/login')
    fireEvent.click(screen.getByTestId('login-microsoft'))
    expect(window.location.href).toBe(LOGIN_URL)
    expect(window.location.href).toContain('/api/v1/auth/login')
  })

  it('shows distinct wrong-tenant copy for ?authError=wrong_tenant', () => {
    renderAt('/login?authError=wrong_tenant')
    expect(screen.getByTestId('login-notice').textContent).toContain('BIAL organization')
  })

  it('shows a generic failure banner for other authError reasons', () => {
    renderAt('/login?authError=invalid_callback')
    const text = screen.getByTestId('login-notice').textContent
    expect(text).toContain('Sign-in failed')
    expect(text).not.toContain('BIAL organization')
  })

  // Regression test for the prototype-pollution fix (c2822c7): before the Object.hasOwn guard,
  // AUTH_ERROR_BANNERS[authError] resolved a key like `__proto__` to a real Object.prototype
  // value, the `|| GENERIC_AUTH_ERROR` fallback never fired (truthy), and React threw —
  // white-screening the unauthenticated /login page for anyone who clicks a crafted link.
  //
  // Mutation receipt: reverting the guard to a bare index fails all four keys, but NOT the
  // same way — `__proto__` reproduces the crash, `constructor` renders an empty notice,
  // `toString`/`hasOwnProperty` fail differently again — so trimming this list to just
  // `__proto__` would silently drop the other failure shapes.
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'does not crash and shows the generic banner for ?authError=%s (prototype-pollution guard)',
    (key) => {
      renderAt(`/login?authError=${key}`)
      const text = screen.getByTestId('login-notice').textContent
      expect(text).toContain('Sign-in failed')
    },
  )

  // Companion assertion for the same commit's SIGNOUT_BANNERS[reason] guard — lower severity
  // since `reason` comes from localStorage, not the URL. Unlike authError there is no generic
  // fallback: an unrecognized reason never calls setNotice, so the correct behavior is no
  // banner at all, not a crash and not a substitute message.
  it('does not crash and shows no banner for a poisoned signout-reason key (prototype-pollution guard)', () => {
    localStorage.setItem('bial_signout_reason', '__proto__')
    renderAt('/login')
    // Page survived FIRST: an absent notice is ALSO what a crashed page renders, so on its own
    // that assertion would false-green with the guard fully reverted — add an error boundary
    // around LoginPage and this goes green with the guard fully reverted, because vitest's
    // unhandled-rejection surfacing (not this test) is what makes the bare
    // `queryByTestId('login-notice')).toBeNull()` discriminate today. Asserting the sign-in
    // button is still there is what proves the page actually rendered.
    expect(screen.getByTestId('login-microsoft')).toBeTruthy()
    expect(screen.queryByTestId('login-notice')).toBeNull()
  })

  it('shows distinct, non-alarming suspension copy for ?authError=account_suspended', () => {
    renderAt('/login?authError=account_suspended')
    const text = screen.getByTestId('login-notice').textContent
    expect(text).toContain('administrator')
    // Not the user's fault: never the generic "sign-in failed", never the tenant copy.
    expect(text).not.toContain('Sign-in failed')
    expect(text).not.toContain('BIAL organization')
  })

  it('keeps the generic banner for ?authError=auth_failed', () => {
    renderAt('/login?authError=auth_failed')
    const text = screen.getByTestId('login-notice').textContent
    expect(text).toContain('Sign-in failed')
    expect(text).not.toContain('administrator')
  })

  it('shows the signout-reason banner when there is no authError', () => {
    localStorage.setItem('bial_signout_reason', 'logged_out')
    renderAt('/login')
    expect(screen.getByTestId('login-notice').textContent).toContain('signed out')
  })

  it('shows no banner on a clean visit', () => {
    renderAt('/login')
    expect(screen.queryByTestId('login-notice')).toBeNull()
  })

  // Rendering half of the fix — Navbar.test.jsx proves the state reaches this route at all.
  it('shows the sign-out warning carried as router state', () => {
    renderAtWithState('/login', { signoutWarning: 'Sign-out may be incomplete on this device.' })
    expect(screen.getByTestId('login-notice').textContent).toBe(
      'Sign-out may be incomplete on this device.',
    )
  })

  it('does not crash and shows no banner when the router state has no signoutWarning key', () => {
    renderAtWithState('/login', { somethingElse: true })
    expect(screen.getByTestId('login-microsoft')).toBeTruthy()
    expect(screen.queryByTestId('login-notice')).toBeNull()
  })

  it('an authError still wins over a carried sign-out warning', () => {
    renderAtWithState('/login?authError=wrong_tenant', {
      signoutWarning: 'Sign-out may be incomplete on this device.',
    })
    expect(screen.getByTestId('login-notice').textContent).toContain('BIAL organization')
  })
})
