/**
 * FOLLOWING THE NEWEST CONTENT, AND THE WAY BACK TO IT.
 *
 * The thread's own viewport ships auto-scroll with a bottom-proximity check, so nothing here pins
 * the transcript; what is left to test is the way back to the bottom.
 *
 * `ThreadPrimitive.ScrollToBottom` renders a `disabled` button rather than disappearing, so its
 * hook is kept and its button is hand-built — ComposerBox.tsx carries why. The assertions are
 * therefore about REACHABILITY: present or absent, and never carrying a real `disabled`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import ScrollToLatest, { scrollControlLabel } from '../ScrollToLatest'

const h = vi.hoisted(() => ({ isAtBottom: true, scrollToBottom: vi.fn() }))

// The viewport store, stubbed at the one selector this component reads. Mocking the module rather
// than mounting a whole runtime keeps this a test of the CONTROL: whether a thread scrolls is the
// library's business and is covered by its own suite.
vi.mock('@assistant-ui/react', () => ({
  useThreadViewport: (select: (s: { isAtBottom: boolean; scrollToBottom: unknown }) => unknown) =>
    select({ isAtBottom: h.isAtBottom, scrollToBottom: h.scrollToBottom }),
}))

afterEach(() => {
  cleanup()
  h.isAtBottom = true
  h.scrollToBottom.mockClear()
})

const control = () => screen.queryByTestId('scroll-to-latest')

describe('it is ABSENT at the bottom, not disabled', () => {
  it('renders nothing while the reader is already at the newest message', () => {
    h.isAtBottom = true
    const { container } = render(<ScrollToLatest isRunning={false} hasPendingOffer={false} />)
    expect(control()).toBeNull()
    // The mechanical form of "the library's button is not used": there is no element at all, so
    // there is nothing in the reading line to be disabled.
    expect(container.querySelector('[disabled]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('appears once there is somewhere to go', () => {
    h.isAtBottom = false
    render(<ScrollToLatest isRunning={false} hasPendingOffer={false} />)
    expect(control()).toBeTruthy()
  })

  it('never carries a real `disabled`, in any state it can render in', () => {
    h.isAtBottom = false
    for (const [isRunning, hasPendingOffer] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const { container, unmount } = render(
        <ScrollToLatest isRunning={isRunning} hasPendingOffer={hasPendingOffer} />,
      )
      expect(container.querySelector('[disabled]')).toBeNull()
      expect(screen.getByTestId('scroll-to-latest')).toBeTruthy() // liveness for the sweep
      unmount()
    }
  })
})

describe('one control, three things to say', () => {
  it('names the offer above everything else (R29a)', () => {
    // When a pending offer has scrolled out of view this is how it stays reachable — which is what
    // lets there be NO second Build button anywhere else on the screen.
    expect(scrollControlLabel(true, true)).toBe('Back to the plan waiting for you')
    expect(scrollControlLabel(false, true)).toBe('Back to the plan waiting for you')
  })

  it('says a reply is arriving while a turn runs (R35a)', () => {
    expect(scrollControlLabel(true, false)).toBe('A reply is arriving — jump to it')
  })

  it('is plain otherwise', () => {
    expect(scrollControlLabel(false, false)).toBe('Jump to the newest message')
  })

  it('renders the sentence it chose', () => {
    h.isAtBottom = false
    render(<ScrollToLatest isRunning hasPendingOffer={false} />)
    expect(control()?.textContent).toContain('A reply is arriving')
  })
})

describe('pressing it', () => {
  it('scrolls to the bottom, smoothly', () => {
    h.isAtBottom = false
    render(<ScrollToLatest isRunning={false} hasPendingOffer={false} />)
    control()?.click()
    expect(h.scrollToBottom).toHaveBeenCalledWith({ behavior: 'smooth' })
  })

  it('does not swallow pointer events across the whole strip', () => {
    // The wrapper spans the viewport so the pill can centre, and it must NOT eat clicks meant for
    // the transcript underneath it — only the button itself is interactive.
    h.isAtBottom = false
    const { container } = render(<ScrollToLatest isRunning={false} hasPendingOffer={false} />)
    expect((container.firstElementChild as HTMLElement).className).toContain('pointer-events-none')
    expect(control()?.className).toContain('pointer-events-auto')
  })
})
