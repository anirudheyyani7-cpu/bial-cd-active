import { describe, it, expect, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import TurnBanner, { withMailtoLinks } from '../TurnBanner'

afterEach(cleanup)

// The banner slot is where every sentence the platform says to a citizen lands — recovered,
// couldn't check, budget used up, and more — all at the same moment, in the same place.
describe('TurnBanner — one banner, newest wins', () => {
  it('renders no visible box when there is nothing to say', () => {
    render(<TurnBanner text={null} />)
    // NOT an empty bordered box: a permanent visual artefact above the composer reads as broken
    // UI for nearly all of the banner's lifetime, since most of the time nothing is wrong.
    expect(screen.queryByTestId('turn-banner')).toBeNull()
    // LIVENESS for that absence, and the property it is paired with: the live region IS there.
    expect(document.querySelector('[role="status"]')).toBeTruthy()
  })

  it('keeps the live region mounted so the announcement actually lands', () => {
    // ★ Inserting a region together with its text announces inconsistently across screen readers,
    // so the element must be in the accessibility tree BEFORE the text arrives — never rendered
    // into existence alongside its own sentence.
    //
    // Mutation check: return `null` when there is no text and the first assertion goes red.
    const { rerender } = render(<TurnBanner text={null} />)
    const region = document.querySelector('[role="status"]')
    expect(region).toBeTruthy()
    expect(region?.textContent).toBe('')

    rerender(<TurnBanner text="That change didn’t come together." />)

    // The SAME element, now carrying text — not a new one inserted alongside it.
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'That change didn’t come together.',
    )
  })

  it('announces politely, never assertively', () => {
    render(<TurnBanner text="We brought your app back." />)
    // `assertive` is reserved for the two things that genuinely interrupt on this page (a failed
    // relaunch, a failed save) — spending it here would drown those out.
    expect(document.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
    expect(document.querySelector('[aria-live="assertive"]')).toBeNull()
  })

  it('shows the newest sentence and nothing of the one it replaced', () => {
    // Two platform sentences about the same app on screen together is a contradiction, not extra
    // information — so this asserts the OLD text is gone. "There is one banner" alone couldn't
    // fail for a component that just takes a single string prop; an appending bug would still pass.
    const { rerender } = render(<TurnBanner text="We brought your app back." />)
    rerender(<TurnBanner text="That change didn’t come together." />)

    expect(screen.getByTestId('turn-banner').textContent).toBe('That change didn’t come together.')
    expect(screen.queryByText(/brought your app back/i)).toBeNull()
  })

  it('clears when the sentence is withdrawn', () => {
    const { rerender } = render(<TurnBanner text="We couldn’t check on your app's workspace." />)
    expect(screen.getByTestId('turn-banner')).toBeTruthy() // liveness for the absence below
    rerender(<TurnBanner text={null} />)
    expect(screen.queryByTestId('turn-banner')).toBeNull()
  })
})

// "Who to ask for more" has to be CLICKABLE, or it is a string the citizen retypes.
describe('an address in a platform sentence', () => {
  // The surface this sentence actually reaches: the isolated linkifier tests below would pass
  // even if the banner stopped calling them — this is the one that actually fails.
  it('renders as a real mailto anchor', () => {
    render(
      <TurnBanner text="Today's budget is used up. If you need more before then, ask support@bial.example." />,
    )

    const link = screen.getByRole('link', { name: 'support@bial.example' })
    expect(link.getAttribute('href')).toBe('mailto:support@bial.example')
  })

  it('leaves a sentence with no address byte-identical', () => {
    const plain = 'Your workspace had been reset, so we are putting your app back.'
    render(<TurnBanner text={plain} />)

    expect(screen.getByTestId('turn-banner').textContent).toBe(plain)
    // LIVENESS: the linkifier really did run over this text and chose to add nothing.
    expect(screen.queryByRole('link')).toBeNull()
  })
})

// The linkifier's own cases. The two describes above assert the banner USES it — these assert
// WHAT it does, which the surface-level pair can't reach with a single address.
describe('withMailtoLinks', () => {
  it('linkifies every address in the sentence and never swallows a trailing full stop', () => {
    // A `mailto:` that carries the sentence's final "." into the mailbox name bounces, and the
    // citizen has no way to tell why.
    const nodes = withMailtoLinks('Write to a@b.com or c@d.co.uk.')
    const hrefs = nodes
      .filter((n): n is ReactElement<{ href: string }> => typeof n !== 'string')
      .map((n) => n.props.href)
    expect(hrefs).toEqual(['mailto:a@b.com', 'mailto:c@d.co.uk'])
    // The prose either side survives — a linkifier that returned ONLY the matches would pass
    // every assertion above and lose the entire message.
    expect(nodes.filter((n) => typeof n === 'string').join('')).toBe('Write to  or .')
  })

  it('leaves a sentence with no address exactly as it was', () => {
    expect(withMailtoLinks('Nothing to link here.')).toEqual(['Nothing to link here.'])
  })
})
