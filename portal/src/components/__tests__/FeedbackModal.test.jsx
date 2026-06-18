import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import FeedbackModal from '../FeedbackModal.jsx'

// Tell React this is an act() environment (testing-library normally sets this).
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderModal(props = {}, route = '/chat') {
  const onSubmitted = props.onSubmitted ?? vi.fn()
  const onClose = props.onClose ?? vi.fn()
  const submitFn = props.submitFn ?? vi.fn(async () => ({ ok: true }))
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <FeedbackModal open onClose={onClose} onSubmitted={onSubmitted} submitFn={submitFn} />
      </MemoryRouter>,
    )
  })
  return { onSubmitted, onClose, submitFn }
}

const byTestId = (id) => container.querySelector(`[data-testid="${id}"]`)
const textarea = () => byTestId('feedback-message')
const submitBtn = () => byTestId('feedback-submit')

/** Set a textarea's value the React-compatible way (native setter + input event). */
function typeInto(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('FeedbackModal', () => {
  it('disables Submit when empty, enables it once text is entered', () => {
    renderModal()
    expect(submitBtn().disabled).toBe(true)
    typeInto(textarea(), 'something is broken')
    expect(submitBtn().disabled).toBe(false)
  })

  it('disables Submit and turns the counter red at/over the byte cap', () => {
    renderModal()
    typeInto(textarea(), 'a'.repeat(4001))
    expect(submitBtn().disabled).toBe(true)
    expect(byTestId('feedback-counter').className).toContain('text-danger')
  })

  it('submits the typed message with the current path, then calls onSubmitted', async () => {
    const { onSubmitted, submitFn } = renderModal({}, '/admin/feedback')
    typeInto(textarea(), '  please fix this  ')
    await click(submitBtn())
    expect(submitFn).toHaveBeenCalledWith('please fix this', '/admin/feedback')
    expect(onSubmitted).toHaveBeenCalledTimes(1)
  })

  it('on a rejected submit shows the error inline and stays open (no onSubmitted)', async () => {
    const submitFn = vi.fn(async () => {
      throw new Error('Server is down, try later.')
    })
    const { onSubmitted } = renderModal({ submitFn })
    typeInto(textarea(), 'a bug')
    await click(submitBtn())
    expect(byTestId('feedback-error').textContent).toContain('Server is down, try later.')
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(textarea()).not.toBeNull() // modal still rendered
  })

  it('focuses the textarea on open', () => {
    renderModal()
    expect(document.activeElement).toBe(textarea())
  })
})
