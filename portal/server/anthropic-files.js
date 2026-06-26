/**
 * Anthropic Files API wrapper (through the injected Foundry client).
 *
 * The derived deck PDF is uploaded ONCE at attach time and referenced by its
 * `file_id` on every turn thereafter (sticky, cheap under the prompt cache). The
 * PDF is an INTERNAL artifact: only the `file_id` is ever stored/sent, never
 * surfaced to the user (who only ever sees the original `.pptx`).
 *
 * Every call needs the `files-api-2025-04-14` beta; the SDK sets the header from
 * the `betas` param. The client is INJECTED (mirroring how server.js builds
 * `claudeClient`) so this unit-tests with a fake — and so a Files-API failure
 * surfaces as a typed error the route can map.
 */

export const FILES_API_BETA = 'files-api-2025-04-14'

/** Typed error so the route maps a Files-API failure faithfully (never a raw 500
 *  that reads as an unhandled bug). Upstream failures map to 502; an upstream 4xx
 *  is passed through. */
export class AnthropicFilesError extends Error {
  constructor(message, { status = 502, code = 'FILES_API_ERROR' } = {}) {
    super(message)
    this.name = 'AnthropicFilesError'
    this.status = status
    this.code = code
  }
}

export function createAnthropicFiles(client) {
  function filesResource() {
    const files = client?.beta?.files
    if (!files) {
      throw new AnthropicFilesError('Files API is not configured.', {
        status: 503,
        code: 'FILES_API_UNCONFIGURED',
      })
    }
    return files
  }

  /**
   * Upload a PDF buffer to the Files API.
   * @returns {Promise<{ fileId: string }>}
   */
  async function uploadPdf(buffer, name = 'deck.pdf') {
    const files = filesResource()
    const filename = /\.pdf$/i.test(name) ? name : `${name}.pdf`
    let res
    try {
      res = await files.upload({
        file: new File([buffer], filename, { type: 'application/pdf' }),
        betas: [FILES_API_BETA],
      })
    } catch (err) {
      // Pass an upstream 4xx through (e.g. 413); map 5xx / unknown to 502.
      const status = err?.status >= 400 && err?.status < 500 ? err.status : 502
      throw new AnthropicFilesError(
        `Could not upload the converted deck (${err?.message || 'Files API error'}).`,
        { status, code: 'FILES_UPLOAD_FAILED' },
      )
    }
    if (!res?.id) {
      throw new AnthropicFilesError('Files API did not return a file id.', {
        status: 502,
        code: 'FILES_UPLOAD_FAILED',
      })
    }
    return { fileId: res.id }
  }

  /**
   * Delete by file_id. Best-effort: a 404 (already gone) is swallowed so cleanup
   * is idempotent; other errors propagate so the caller can log them (cleanup
   * must never block a user-facing delete).
   */
  async function deleteFile(fileId) {
    if (!fileId) return
    const files = filesResource()
    try {
      await files.delete(fileId, { betas: [FILES_API_BETA] })
    } catch (err) {
      if (err?.status === 404) return // already deleted — idempotent
      throw err
    }
  }

  return { uploadPdf, deleteFile }
}
