import { describe, it, expect } from 'vitest'
import { filterCodeFromContent, extractPreviewCode } from '../BuilderPage.jsx'
import { contentToText } from '../../utils/attachmentStore.js'

describe('BuilderPage content helpers', () => {
  it('filterCodeFromContent(contentToText(arrayContent)) never throws or yields [object Object]', () => {
    const arrayContent = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'build an app like this ```jsx:preview\nconst x = 1\n``` thanks' },
    ]
    let out
    expect(() => {
      out = filterCodeFromContent(contentToText(arrayContent))
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
