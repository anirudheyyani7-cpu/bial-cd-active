import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AttachmentChips from '../AttachmentChips.jsx'

// AttachmentChips is the SHARED persisted chip (used on every page, incl. the
// reloaded conversation view). A text attachment must take the labelled-icon
// branch — not the image branch — otherwise a reloaded chat shows a broken <img>.
// The image byte read lives in an effect (not run under SSR), so the structural
// contrast below (text/pdf → no <img>; image → <img>) proves the branches exist.
describe('AttachmentChips — descriptor branches', () => {
  it('renders a text/CSV attachment as a labelled chip: filename shown, no <img>', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[{ attachmentId: 't1', kind: 'text', name: 'roster.csv', mediaType: 'text/csv' }]} />,
    )
    expect(html).toContain('roster.csv')
    expect(html).not.toContain('<img')
  })

  it('renders a .txt attachment as a labelled chip with no <img>', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[{ attachmentId: 't2', kind: 'text', name: 'notes.txt', mediaType: 'text/plain' }]} />,
    )
    expect(html).toContain('notes.txt')
    expect(html).not.toContain('<img')
  })

  it('renders a PDF as a clickable labelled chip, no <img>', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[{ attachmentId: 'd1', kind: 'document', name: 'spec.pdf', mediaType: 'application/pdf' }]} />,
    )
    expect(html).toContain('spec.pdf')
    expect(html).not.toContain('<img')
  })

  it('contrast: an image attachment still goes down the <img> path', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[{ attachmentId: 'i1', kind: 'image', name: 'shot.png', mediaType: 'image/png' }]} />,
    )
    expect(html).toContain('<img')
  })
})
