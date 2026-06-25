/**
 * Parse-time governor (R8): runs the CPU-bound parse in a worker thread under a
 * HARD wall-clock budget. The pure caps in file-parse.js bound the common cases;
 * this is the live, adversarial-input backstop — a parse that overruns the budget
 * is terminated and surfaced as a clean 413, never an event-loop stall.
 *
 * A fresh worker per parse (no pool) keeps the lifecycle trivial and the failure
 * mode clean (terminate == hard stop). Parse is a deliberate, rate-limited user
 * action, so the per-call worker startup is acceptable; a pool is a later
 * optimisation, not a correctness need.
 */
import { Worker } from 'node:worker_threads'
import { posIntOr } from './util-validate.js'
import { FileParseError } from './file-parse.js'

/** Hard wall-clock parse budget (ms). Env: APP_PARSE_TIMEOUT_MS. */
export const PARSE_TIMEOUT_MS = posIntOr(process.env.APP_PARSE_TIMEOUT_MS, 10_000)
/** Worker V8 heap ceiling (MB). The MEMORY backstop the time budget cannot provide: a
 *  zip-bomb that decompresses to GBs (even one that evades the declared-size guard) blows
 *  past this and trips a CONTAINED worker OOM (ERR_WORKER_OUT_OF_MEMORY → 413), instead of
 *  a process-wide OOM that would take down every tenant. Generous enough for any legitimate
 *  ≤18 MB upload's parse peak. Env: APP_PARSE_WORKER_MAX_OLD_MB / _MAX_YOUNG_MB. */
const PARSE_WORKER_MAX_OLD_MB = posIntOr(process.env.APP_PARSE_WORKER_MAX_OLD_MB, 1024)
const PARSE_WORKER_MAX_YOUNG_MB = posIntOr(process.env.APP_PARSE_WORKER_MAX_YOUNG_MB, 64)

const WORKER_URL = new URL('./file-parse.worker.js', import.meta.url)

/** Rebuild the worker-normalised error into the single FileParseError the route maps. */
function toFileParseError(error) {
  if (!error) return new FileParseError('Parsing failed.', { status: 500 })
  return new FileParseError(error.message, { status: error.status || 400, code: error.code || 'FILE_PARSE_ERROR' })
}

/**
 * Parse `buffer` in a worker, rejecting if it overruns `timeoutMs`.
 * @returns {Promise<object>} the structured parse result (see file-parse.js)
 * @throws {FileParseError} on parse failure, unsupported type, or timeout (413)
 */
export function parseInWorker({ buffer, contentType, filename, sheet, __testDelayMs } = {}, { timeoutMs = PARSE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      fn(value)
    }

    const worker = new Worker(WORKER_URL, {
      workerData: { fileBytes: buffer, contentType, filename, sheet, __testDelayMs },
      resourceLimits: {
        maxOldGenerationSizeMb: PARSE_WORKER_MAX_OLD_MB,
        maxYoungGenerationSizeMb: PARSE_WORKER_MAX_YOUNG_MB,
      },
    })

    const timer = setTimeout(() => {
      finish(reject, new FileParseError('Parsing took too long and was stopped. Try a smaller file.', {
        status: 413,
        code: 'PARSE_TIMEOUT',
      }))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref() // never keep the process alive on this timer

    worker.once('message', (msg) => {
      if (msg && msg.ok) finish(resolve, msg.result)
      else finish(reject, toFileParseError(msg && msg.error))
    })
    // A worker 'error' is an INFRASTRUCTURE fault (module load, structured-clone, or — the
    // load-bearing case — ERR_WORKER_OUT_OF_MEMORY from the heap ceiling). A raw Node Error
    // has no status/code, so wrap it: an OOM is a too-large input (413), anything else a 500.
    worker.once('error', (err) => {
      const oom = err && err.code === 'ERR_WORKER_OUT_OF_MEMORY'
      finish(reject, new FileParseError(
        oom ? 'File is too large or complex to parse safely.' : 'Parsing failed unexpectedly.',
        oom ? { status: 413, code: 'FILE_TOO_LARGE' } : { status: 500, code: 'PARSE_FAILED' },
      ))
    })
    worker.once('exit', (code) => {
      if (settled || code === 0) return
      finish(reject, new FileParseError('Parsing failed unexpectedly.', { status: 500, code: 'PARSE_FAILED' }))
    })
  })
}
