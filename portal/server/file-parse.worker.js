/**
 * Worker-thread entry for file parsing. The actual work lives in the PURE
 * file-parse.js; this thin shell just runs it OFF the main event loop so a large
 * or adversarial untrusted file can neither block the server nor outrun the
 * wall-clock budget the runner enforces by terminating this worker (R8).
 *
 * Errors are normalised to a plain `{ message, status, code }` (a thrown subclass
 * does not survive structured-clone with its custom fields), so the runner can
 * rebuild a single FileParseError the route maps HTTP-faithfully.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { parseFile } from './file-parse.js'

async function run() {
  const { fileBytes, contentType, filename, sheet, __testDelayMs } = workerData || {}

  // Test-only seam: block this thread (NOT the main loop) so the runner's timeout
  // path is deterministically exercisable. Never set in production code.
  if (__testDelayMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, __testDelayMs)
  }

  const buffer = Buffer.from(fileBytes) // structured-clone delivers a Uint8Array
  const result = await parseFile({ buffer, contentType, filename, sheet })
  parentPort.postMessage({ ok: true, result })
}

run().catch((err) => {
  const isOffice = err && err.name === 'OfficeExtractError'
  parentPort.postMessage({
    ok: false,
    error: {
      message: err && err.message ? err.message : 'Parsing failed.',
      status: (err && err.status) || 400,
      code: (err && err.code) || (isOffice ? 'INVALID_OFFICE_FILE' : 'FILE_PARSE_ERROR'),
    },
  })
})
