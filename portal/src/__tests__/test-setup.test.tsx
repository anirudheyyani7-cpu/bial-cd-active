/**
 * The sufficiency check for `src/test-setup.ts`.
 *
 * WHY THIS EXISTS
 *
 * Deliberately small: asserting "the global the setup file defines is defined" restates the
 * setup file and goes green whether the shim actually works. Real proof lives in the units that
 * cannot run without these shims (activity group, attachment dialog, copy button).
 *
 * What only this file can pin: that the `setupFiles` key exists in `vitest.config.js` at all —
 * one line with no compiler or linter behind it. Drop it and a consumer three units away fails
 * with a Radix stack trace naming an internal, far from "the config lost a line".
 *
 * THE CANARY IS NOT WHAT IT LOOKS LIKE. Measured by deleting the key and running the file: the
 * Radix Dialog/Select render tests below stay GREEN without it — neither's `click`-driven open
 * reaches the pointer-capture or scroll paths bare jsdom is missing. The two SHAPE tests are what
 * actually go red, and are kept for that reason:
 *  - the clipboard spy must be REJECTABLE (the copy button's failure path needs it);
 *  - `matchMedia` must return `removeEventListener`, or a reduced-motion subscriber throws on
 *    UNMOUNT.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

describe('the test environment has the shims the component libraries need', () => {
  it('OPENS a real Radix Select in a file that stubs nothing', async () => {
    // Not the canary (see the docblock) — but the closest real consumer of the pointer-capture
    // shims: a Radix Select on the history filter. `fireEvent.click` then `findByRole('option')`
    // is the working recipe; `fireEvent.change` on a `combobox` button silently no-ops (same
    // warning in `MarketplacePage.test.tsx`).
    render(
      <Select>
        <SelectTrigger aria-label="Kind">
          <SelectValue placeholder="Any kind" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="plan">Plan</SelectItem>
          <SelectItem value="build">Build</SelectItem>
        </SelectContent>
      </Select>,
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Kind' }))
    expect(await screen.findByRole('option', { name: 'Build' })).toBeTruthy()
  })

  it('renders and unmounts a real Radix Dialog in a file that stubs nothing', () => {
    // Not a canary — a Dialog needs no shims — but the attachment preview lives in one, so
    // this pins that the vendored component mounts and tears down cleanly.
    const { unmount } = render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attachment</DialogTitle>
            <DialogDescription>A preview over the conversation.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Attachment')).toBeTruthy()
    expect(() => unmount()).not.toThrow()
  })

  it('gives navigator.clipboard a spy that resolves, and that a test can make reject', async () => {
    // Clipboard writes genuinely fail — insecure origins, denied permissions — and the copy
    // button has to announce that; a shim that can only succeed cannot test the half that matters.
    await expect(navigator.clipboard.writeText('hello')).resolves.toBeUndefined()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello')

    const write = vi.mocked(navigator.clipboard.writeText)
    write.mockRejectedValueOnce(new Error('NotAllowedError'))
    await expect(navigator.clipboard.writeText('nope')).rejects.toThrow('NotAllowedError')

    // And it recovers, so one test's rejection does not leak into the next.
    await expect(navigator.clipboard.writeText('again')).resolves.toBeUndefined()
  })

  it('gives matchMedia both addEventListener AND removeEventListener', () => {
    // `usePrefersReducedMotion` subscribes on mount and unsubscribes on unmount — a shim missing
    // `removeEventListener` throws when the component goes away, surfacing as an unrelated failure.
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    expect(mq.matches).toBe(false) // default is "animate", i.e. today's behaviour, unchanged
    expect(typeof mq.addEventListener).toBe('function')
    expect(typeof mq.removeEventListener).toBe('function')

    const onChange = vi.fn()
    expect(() => {
      mq.addEventListener('change', onChange)
      mq.removeEventListener('change', onChange)
    }).not.toThrow()
  })
})
