import { describe, it, expect, beforeEach } from 'vitest'
import { loadBuilds, newBuild, appendBuilderMessage, getBuild, deleteBuild } from '../builderHistory.js'
import { extractPreviewCode } from '../../pages/BuilderPage.jsx'

function setUser(username) {
  localStorage.setItem('bial_user', JSON.stringify({ username }))
}

beforeEach(() => {
  localStorage.clear()
})

describe('builderHistory', () => {
  it('newBuild + appendBuilderMessage persist; getBuild restores messages + context', () => {
    setUser('alice')
    const ctx = { dataSource: 'aodb', theme: 'bial', hasSchema: true, uploadedFiles: [] }
    const id = newBuild('flight tracker', ctx)
    appendBuilderMessage(id, { id: 'm1', role: 'user', content: 'flight tracker', timestamp: '2026-06-17T00:00:00.000Z' })
    appendBuilderMessage(id, { id: 'm2', role: 'assistant', content: 'done', timestamp: '2026-06-17T00:00:01.000Z' })

    const build = getBuild(id)
    expect(build.context).toEqual(ctx)
    expect(build.messages).toHaveLength(2)
    expect(build.title).toBe('flight tracker')
  })

  it('persists under the user-namespaced key', () => {
    setUser('alice')
    newBuild('x')
    expect(localStorage.getItem('bial_builder_history:alice')).toBeTruthy()
  })

  it('isolates builds per user (alice not visible as bob)', () => {
    setUser('alice')
    newBuild('alice build')
    expect(loadBuilds()).toHaveLength(1)
    setUser('bob')
    expect(loadBuilds()).toHaveLength(0)
    setUser('alice')
    expect(loadBuilds()).toHaveLength(1)
  })

  it('survives a session clear (tokens removed) for the same user', () => {
    setUser('alice')
    newBuild('keep me')
    localStorage.removeItem('bial_access_token')
    localStorage.removeItem('bial_refresh_token')
    setUser('alice')
    expect(loadBuilds()).toHaveLength(1)
  })

  it('deleteBuild removes a build from the list', () => {
    setUser('alice')
    const a = newBuild('a')
    const b = newBuild('b')
    expect(loadBuilds()).toHaveLength(2)
    deleteBuild(a)
    const ids = loadBuilds().map((x) => x.id)
    expect(ids).toEqual([b])
  })

  it('round-trips an attachment-bearing message (refs only) and re-extractable preview code', () => {
    setUser('alice')
    const id = newBuild('build from screenshot')
    appendBuilderMessage(id, {
      id: 'm1',
      role: 'user',
      content: 'build from screenshot',
      attachments: [{ id: 'att1', name: 'shot.png', mediaType: 'image/png', size: 1234 }],
      timestamp: '2026-06-17T00:00:00.000Z',
    })
    appendBuilderMessage(id, {
      id: 'm2',
      role: 'assistant',
      content: 'Here you go ```jsx:preview\nfunction PreviewApp(){return null}\n```',
      timestamp: '2026-06-17T00:00:01.000Z',
    })

    const build = getBuild(id)
    expect(build.messages[0].attachments).toEqual([
      { id: 'att1', name: 'shot.png', mediaType: 'image/png', size: 1234 },
    ])
    const lastAssistant = [...build.messages].reverse().find((m) => m.role === 'assistant')
    expect(extractPreviewCode(lastAssistant.content)).toBe('function PreviewApp(){return null}')
  })
})
