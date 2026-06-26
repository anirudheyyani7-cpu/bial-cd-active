import { describe, it, expect, vi } from 'vitest'
import { createAnthropicFiles, AnthropicFilesError, FILES_API_BETA } from '../anthropic-files.js'

function fakeClient({ upload, del } = {}) {
  return { beta: { files: { upload: upload || vi.fn(), delete: del || vi.fn() } } }
}

describe('createAnthropicFiles.uploadPdf', () => {
  it('uploads with the beta header and returns the file_id', async () => {
    const upload = vi.fn(async () => ({ id: 'file_abc123' }))
    const client = fakeClient({ upload })
    const { uploadPdf } = createAnthropicFiles(client)

    const out = await uploadPdf(Buffer.from('%PDF-1.5 fake'), 'Quarterly Review.pdf')

    expect(out).toEqual({ fileId: 'file_abc123' })
    expect(upload).toHaveBeenCalledTimes(1)
    const params = upload.mock.calls[0][0]
    expect(params.betas).toContain(FILES_API_BETA)
    expect(params.file).toBeInstanceOf(File)
    expect(params.file.name).toBe('Quarterly Review.pdf')
    expect(params.file.type).toBe('application/pdf')
  })

  it('forces a .pdf filename', async () => {
    const upload = vi.fn(async () => ({ id: 'file_1' }))
    const { uploadPdf } = createAnthropicFiles(fakeClient({ upload }))
    await uploadPdf(Buffer.from('x'), 'deck')
    expect(upload.mock.calls[0][0].file.name).toBe('deck.pdf')
  })

  it('passes an upstream 4xx through as the typed error status', async () => {
    const upload = vi.fn(async () => {
      const e = new Error('Payload Too Large')
      e.status = 413
      throw e
    })
    const { uploadPdf } = createAnthropicFiles(fakeClient({ upload }))
    await expect(uploadPdf(Buffer.from('x'), 'd.pdf')).rejects.toMatchObject({
      name: 'AnthropicFilesError',
      status: 413,
      code: 'FILES_UPLOAD_FAILED',
    })
  })

  it('maps an upstream 5xx / unknown failure to 502', async () => {
    const upload = vi.fn(async () => {
      const e = new Error('boom')
      e.status = 500
      throw e
    })
    const { uploadPdf } = createAnthropicFiles(fakeClient({ upload }))
    await expect(uploadPdf(Buffer.from('x'), 'd.pdf')).rejects.toMatchObject({ status: 502 })

    const upload2 = vi.fn(async () => {
      throw new Error('network down') // no status
    })
    const { uploadPdf: up2 } = createAnthropicFiles(fakeClient({ upload: upload2 }))
    await expect(up2(Buffer.from('x'), 'd.pdf')).rejects.toMatchObject({ status: 502 })
  })

  it('errors when the response has no id', async () => {
    const upload = vi.fn(async () => ({}))
    const { uploadPdf } = createAnthropicFiles(fakeClient({ upload }))
    await expect(uploadPdf(Buffer.from('x'), 'd.pdf')).rejects.toMatchObject({
      status: 502,
      code: 'FILES_UPLOAD_FAILED',
    })
  })

  it('throws 503 when the client has no Files API', async () => {
    const { uploadPdf } = createAnthropicFiles({})
    await expect(uploadPdf(Buffer.from('x'), 'd.pdf')).rejects.toMatchObject({
      status: 503,
      code: 'FILES_API_UNCONFIGURED',
    })
  })
})

describe('createAnthropicFiles.deleteFile', () => {
  it('deletes by id with the beta header', async () => {
    const del = vi.fn(async () => ({ id: 'file_x', type: 'file_deleted' }))
    const { deleteFile } = createAnthropicFiles(fakeClient({ del }))
    await deleteFile('file_x')
    expect(del).toHaveBeenCalledWith('file_x', { betas: [FILES_API_BETA] })
  })

  it('swallows a 404 (already deleted — idempotent)', async () => {
    const del = vi.fn(async () => {
      const e = new Error('not found')
      e.status = 404
      throw e
    })
    const { deleteFile } = createAnthropicFiles(fakeClient({ del }))
    await expect(deleteFile('gone')).resolves.toBeUndefined()
  })

  it('propagates non-404 errors so the caller can log them', async () => {
    const del = vi.fn(async () => {
      const e = new Error('server error')
      e.status = 500
      throw e
    })
    const { deleteFile } = createAnthropicFiles(fakeClient({ del }))
    await expect(deleteFile('file_x')).rejects.toThrow('server error')
  })

  it('is a no-op for a falsy file_id', async () => {
    const del = vi.fn()
    const { deleteFile } = createAnthropicFiles(fakeClient({ del }))
    await deleteFile(undefined)
    await deleteFile('')
    expect(del).not.toHaveBeenCalled()
  })
})

it('AnthropicFilesError defaults to a 502', () => {
  expect(new AnthropicFilesError('x').status).toBe(502)
})
