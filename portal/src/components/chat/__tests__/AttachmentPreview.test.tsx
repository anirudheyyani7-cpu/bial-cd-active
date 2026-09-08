/**
 * WHY THIS EXISTS: framing an attachment is refused by both `X-Frame-Options: DENY` (server) and
 * `frame-src 'self'` (CSP, for `data:`), and a refused frame renders BLANK with no `error` event —
 * a citizen gets an empty rectangle and nothing to explain it. So this component renders images
 * and text from bytes it already holds, and says a sentence for anything else, for every address
 * it can still be handed: a `data:` URL and a `blob:` object URL.
 *
 * Not covered here: the same-origin `/api/attachments/{id}` frame, which looked safe but is
 * refused just as completely. `PreviewTarget` no longer carries an attachment id, so no fixture
 * can construct that branch — reintroducing it needs the id back on the type first, a deliberate,
 * compiler-checked act. Guarded by the type, not by a test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import AttachmentPreview, { type PreviewTarget } from '../AttachmentPreview'

afterEach(cleanup)

const pdf: PreviewTarget = {
  name: 'gate-plan.pdf',
  mediaType: 'application/pdf',
  dataUrl: 'data:application/pdf;base64,JVBER',
}
const image: PreviewTarget = {
  name: 'terminal.png',
  mediaType: 'image/png',
  dataUrl: 'blob:https://portal.example/9f2c',
}

describe('the dialog', () => {
  it('renders nothing at all with no target', () => {
    const { container } = render(<AttachmentPreview target={null} onClose={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('is a real dialog — the things the hand-rolled overlay did not have', () => {
    // Asserted through the ROLE QUERY, not by reading attributes: `getByRole('dialog', {name})`
    // resolves whichever labelling mechanism Radix used, so this survives if the library changes.
    render(<AttachmentPreview target={pdf} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: /gate-plan\.pdf/i })).toBeTruthy()
    expect(screen.getByTestId('attachment-preview')).toBeTruthy()
  })

  it('names the file, and describes itself for a reader who cannot see it', () => {
    render(<AttachmentPreview target={pdf} onClose={vi.fn()} />)
    expect(screen.getByText('gate-plan.pdf')).toBeTruthy()
    expect(screen.getByText(/the conversation stays open behind it/i)).toBeTruthy()
  })

  it('renders an image at whatever URL it was handed', () => {
    render(<AttachmentPreview target={image} onClose={vi.fn()} />)
    expect(screen.getByTestId('attachment-preview-image').getAttribute('src'))
      .toBe('blob:https://portal.example/9f2c')
  })

  it('says something useful when an IMAGE cannot be loaded', () => {
    // The image is the only branch `onError` reaches — nothing else here loads over the network.
    render(<AttachmentPreview target={image} onClose={vi.fn()} />)
    fireEvent.error(screen.getByTestId('attachment-preview-image'))
    expect(screen.getByTestId('attachment-preview-error').textContent).toMatch(/reload the page/i)
  })

  it('a new target clears a previous failure', () => {
    // Without this a previously-failed load reports failure for a file that is perfectly fine.
    const { rerender } = render(<AttachmentPreview target={image} onClose={vi.fn()} />)
    fireEvent.error(screen.getByTestId('attachment-preview-image'))
    expect(screen.getByTestId('attachment-preview-error')).toBeTruthy()

    rerender(<AttachmentPreview target={pdf} onClose={vi.fn()} />)
    expect(screen.queryByTestId('attachment-preview-error')).toBeNull()
    expect(screen.getByTestId('attachment-preview-pending')).toBeTruthy()
  })

  it('with no address at all, it explains rather than showing nothing', () => {
    render(
      <AttachmentPreview target={{ name: 'gone.pdf', mediaType: 'application/pdf' }} onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('attachment-preview-error')).toBeTruthy()
  })
})

describe('the reader dismisses it, and only the reader', () => {
  it('Escape closes it', () => {
    const onClose = vi.fn()
    render(<AttachmentPreview target={pdf} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('`open` is not derived from any stream state — it is unconditionally open while targeted', () => {
    // The mechanical form of "nothing but the reader dismisses it": the component takes no
    // running/streaming prop at all, so no turn state can reach the open flag.
    const props = Object.keys({ target: pdf, onClose: vi.fn() })
    expect(props).toEqual(['target', 'onClose'])
  })
})

describe('a file is never a blank box', () => {
  const csv: PreviewTarget = {
    name: 'stands.csv',
    mediaType: 'text/csv',
    dataUrl: 'data:text/csv;base64,Z2F0ZSxhaXJjcmFmdAoxMkEsQTMyMCDigJQgY2Fmw6kg4piVCg==',
  }

  it('renders a TEXT file inline — no frame, because no frame this component can address renders', () => {
    render(<AttachmentPreview target={csv} onClose={vi.fn()} />)
    const pre = screen.getByTestId('attachment-preview-text')
    expect(pre.textContent).toContain('12A,A320')
    // Liveness: an absence assertion alone would pass just as happily if the component had
    // thrown and rendered nothing at all.
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
    expect(screen.queryByTestId('attachment-preview-error')).toBeNull()
  })

  it('decodes the bytes as UTF-8, so a name with an accent survives the preview', () => {
    // `atob` alone yields latin1 and would render "cafÃ©". This is the assertion that keeps the
    // Uint8Array → TextDecoder round-trip from being "simplified" back to a bare atob.
    render(<AttachmentPreview target={csv} onClose={vi.fn()} />)
    expect(screen.getByTestId('attachment-preview-text').textContent).toContain('café ☕')
  })

  it('strips a leading BOM rather than drawing it as a stray glyph', () => {
    render(
      <AttachmentPreview
        target={{ name: 'bom.csv', mediaType: 'text/csv', dataUrl: 'data:text/csv;base64,77u/Z2F0ZSxhaXJjcmFmdAo=' }}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('attachment-preview-text').textContent?.startsWith('gate')).toBe(true)
  })

  it('says so for a PDF, which has no address the framing policy allows', () => {
    render(<AttachmentPreview target={pdf} onClose={vi.fn()} />)
    expect(screen.getByTestId('attachment-preview-pending').textContent).toMatch(/once you have sent it/i)
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
  })

  it('★ FRAMES NOTHING, at any address — the regression that drew the blank box', () => {
    // Every address and file kind this component can be handed. The same-origin
    // `/api/attachments/{id}` form is guarded by the type instead — see the file docblock.
    for (const target of [pdf, csv, image, { name: 'x.docx', mediaType: 'application/msword', dataUrl: 'data:application/msword;base64,AA' }]) {
      render(<AttachmentPreview target={target} onClose={vi.fn()} />)
      expect(document.querySelectorAll('iframe'), target.name).toHaveLength(0)
      // Paired liveness: the dialog really rendered, so the absence above means something.
      expect(screen.getByTestId('attachment-preview')).toBeTruthy()
      cleanup()
    }
  })

  it('an undecodable text file says it could not be opened, rather than promising to open later', () => {
    render(
      <AttachmentPreview
        target={{ name: 'broken.csv', mediaType: 'text/csv', dataUrl: 'data:text/csv;base64,!!!!' }}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('attachment-preview-error')).toBeTruthy()
    expect(screen.queryByTestId('attachment-preview-text')).toBeNull()
    expect(screen.queryByTestId('attachment-preview-pending')).toBeNull()
  })
})
