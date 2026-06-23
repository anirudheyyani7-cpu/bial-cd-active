import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import LivePreview from '../LivePreview.jsx'

afterEach(cleanup)

const CODE = 'function PreviewApp(){ return null }'

function setup(props = {}) {
  const view = render(<LivePreview previewCode={CODE} generating={false} generationStage={5} {...props} />)
  const iframe = view.container.querySelector('iframe')
  return { ...view, iframe }
}

describe('LivePreview — forwards data wiring + token to the sandboxed preview iframe', () => {
  it('on previewReady, posts previewCode + config + accessToken together', () => {
    const config = { appId: 'a1', appKey: 'k1', baseUrl: '/api', loginRequired: true }
    const { iframe } = setup({ config, accessToken: 'TOK' })
    expect(iframe).toBeTruthy()
    const post = vi.spyOn(iframe.contentWindow, 'postMessage')

    window.dispatchEvent(new MessageEvent('message', { data: { previewReady: true } }))

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ previewCode: expect.stringContaining('PreviewApp'), config, accessToken: 'TOK' }),
      '*',
    )
  })

  it('re-pushes config/token on their own when they change without a code regeneration', () => {
    const { iframe, rerender } = setup({ config: { appId: 'a1', appKey: 'k1', baseUrl: '/api', loginRequired: false } })
    const post = vi.spyOn(iframe.contentWindow, 'postMessage')

    const newConfig = { appId: 'a1', appKey: 'k1', baseUrl: '/api', loginRequired: true }
    rerender(<LivePreview previewCode={CODE} generating={false} generationStage={5} config={newConfig} accessToken="TOK2" />)

    expect(post).toHaveBeenCalledWith({ config: newConfig, accessToken: 'TOK2' }, '*')
  })

  it('omits config/token gracefully when none are provided (legacy callers)', () => {
    const { iframe } = setup() // no config/accessToken props
    const post = vi.spyOn(iframe.contentWindow, 'postMessage')
    window.dispatchEvent(new MessageEvent('message', { data: { previewReady: true } }))
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ previewCode: expect.stringContaining('PreviewApp'), config: undefined, accessToken: undefined }),
      '*',
    )
  })

  it('sandboxes the preview frame with allow-downloads (SAS <a download>) but no allow-same-origin', () => {
    const { iframe } = setup()
    const sandbox = iframe.getAttribute('sandbox')
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).toContain('allow-forms')
    expect(sandbox).toContain('allow-downloads') // U5: download navigation enabled
    expect(sandbox).not.toContain('allow-same-origin') // still can't read the portal session
  })
})
