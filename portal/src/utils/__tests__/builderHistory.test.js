import { describe, it, expect, vi } from 'vitest'
import { newBuild, patchBuildCode } from '../builderHistory.js'

const deps = (fetchImpl) => ({ fetchImpl, getToken: () => 'tok', refresh: vi.fn() })

describe('builderHistory', () => {
  it('newBuild mints a client UUID synchronously (no network)', () => {
    const a = newBuild()
    const b = newBuild()
    expect(a).toMatch(/^[0-9a-f-]{36}$/i)
    expect(a).not.toBe(b)
  })

  it('patchBuildCode PATCHes the build header with the code snapshot', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    const code = { source: 'function PreviewApp(){}', entry: 'PreviewApp', model: 'opus', createdAt: '2026-06-22T00:00:00Z' }
    await patchBuildCode('build-1', code, deps(fetchImpl))
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/conversations/build-1')
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body)).toEqual({ code })
  })
})
