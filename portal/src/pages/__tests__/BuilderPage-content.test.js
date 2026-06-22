import { describe, it, expect } from 'vitest'
import { filterCodeFromContent, extractPreviewCode } from '../BuilderPage.jsx'
import { partsToText } from '../../utils/attachmentStore.js'

describe('BuilderPage content helpers', () => {
  it('filterCodeFromContent(partsToText(parts)) never throws or yields [object Object]', () => {
    // A parts[] message with a file part + a prose text part holding a code fence.
    const parts = [
      { type: 'file', attachmentId: 'a1', kind: 'image', name: 'd.png', mediaType: 'image/png' },
      { type: 'text', text: 'build an app like this ```jsx:preview\nconst x = 1\n``` thanks' },
    ]
    let out
    expect(() => {
      out = filterCodeFromContent(partsToText(parts))
    }).not.toThrow()
    expect(out).toContain('build an app like this')
    expect(out).not.toContain('[object Object]')
    expect(out).not.toContain('const x = 1') // code fence stripped
  })

  it('extractPreviewCode pulls jsx:preview code from a string', () => {
    const text = 'intro ```jsx:preview\nfunction PreviewApp(){return null}\n``` outro'
    expect(extractPreviewCode(text)).toBe('function PreviewApp(){return null}')
    expect(extractPreviewCode('no code here')).toBeNull()
  })
})
