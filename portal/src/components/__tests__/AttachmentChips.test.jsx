import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AttachmentChips from '../AttachmentChips.jsx'

// AttachmentChips is the SHARED persisted chip (used on every page, incl. the
// reloaded conversation view). A text ref must take the labelled-icon branch —
// not the image branch — otherwise a reloaded chat shows a broken <img>. The
// byte read lives in an effect (not run under SSR), so the structural contrast
// below (text → no <img>; image → <img>) is the proof the isText branch exists.
describe('AttachmentChips — persisted text refs', () => {
  it('renders a text/CSV ref as a labelled chip: filename shown, no <img>', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[{ id: 't1', name: 'roster.csv', mediaType: 'text/csv' }]} />,
    )
    expect(html).toContain('roster.csv')
    expect(html).not.toContain('<img')
  })

  it('renders a .txt ref as a labelled chip with no <img>', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[{ id: 't2', name: 'notes.txt', mediaType: 'text/plain' }]} />,
    )
    expect(html).toContain('notes.txt')
    expect(html).not.toContain('<img')
  })

  it('contrast: an image ref still goes down the <img> path', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[{ id: 'i1', name: 'shot.png', mediaType: 'image/png' }]} />,
    )
    expect(html).toContain('<img')
  })
})
