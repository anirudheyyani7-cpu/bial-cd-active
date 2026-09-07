/**
 * ★ WHERE FOCUS GOES WHEN A DIALOG IS UNMOUNTED RATHER THAN CLOSED.
 *
 * Radix restores focus to the opener from `FocusScope`'s cleanup — but every dialog in this
 * portal is rendered CONDITIONALLY, so Escape sets the parent's state to null and React deletes
 * the whole subtree, `FocusScope` included, in the same commit. The restore has no closing state
 * to run in. Measured in the portal container: after Escape, `document.activeElement` was
 * `document.body` while the trigger was still the same node, still connected and still focusable.
 *
 * jsdom has no layout engine but it DOES have a focus model, so the strand itself is testable
 * here; what is not is the geometry, which is why `RM05` in the browser suite measures it too.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

afterEach(() => cleanup())

/** The shape every dialog in this portal is mounted in: conditional on the parent's state. */
function Harness({ onClosed }: { onClosed?: () => void } = {}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      <button type="button">A neighbour</button>
      {open && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setOpen(false)
              onClosed?.()
            }
          }}
        >
          <DialogContent>
            <DialogTitle>The dialog</DialogTitle>
            <button type="button">Inside</button>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

describe('★ a closed dialog never leaves a keyboard on the document body', () => {
  it('gives focus back to the control that opened it', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open it' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByText('The dialog')
    // LIVENESS: the dialog really took focus off the opener, so the restore below is a restore.
    expect(document.activeElement).not.toBe(opener)

    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByText('The dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('does not steal focus back from a caller that moved it deliberately', async () => {
    // `ProjectsPage` sends focus to its heading on close, because the row Radix captured is gone
    // by then. A backstop that fired unconditionally would drag focus back to a detached trigger
    // and undo a fix that is already documented in that file.
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open it' })
    const elsewhere = screen.getByRole('button', { name: 'A neighbour' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByText('The dialog')

    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('The dialog')).toBeNull())
    elsewhere.focus()

    // Give the backstop's frame every chance to fire and be wrong.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    expect(document.activeElement).toBe(elsewhere)
  })

  it('does nothing when the opener itself has left the DOM', async () => {
    // `ProjectsPage`'s case in the shape the backstop actually meets it: an optimistic removal
    // takes the row — and the Delete button Radix captured — out of the tree before the dialog
    // closes. Focusing a detached node is a silent no-op in a browser, so what must be true is
    // that the backstop neither throws nor blanks the focus the page did set.
    render(<VanishingHarness />)
    const landmark = screen.getByRole('button', { name: 'Landmark' })
    const opener = screen.getByRole('button', { name: 'Open it' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByText('The dialog')

    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('The dialog')).toBeNull())
    // LIVENESS: the opener really did leave, so this is the detached case and not the first one.
    expect(screen.queryByRole('button', { name: 'Open it' })).toBeNull()
    landmark.focus()

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    expect(document.activeElement).toBe(landmark)
  })
})

/** The opener leaves with the dialog — an optimistically removed row, in miniature. */
function VanishingHarness() {
  const [open, setOpen] = useState(false)
  const [gone, setGone] = useState(false)
  return (
    <>
      <button type="button">Landmark</button>
      {!gone && (
        <button type="button" onClick={() => setOpen(true)}>
          Open it
        </button>
      )}
      {open && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setOpen(false)
              setGone(true)
            }
          }}
        >
          <DialogContent>
            <DialogTitle>The dialog</DialogTitle>
            <button type="button">Inside</button>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
