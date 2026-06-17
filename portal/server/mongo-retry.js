/**
 * Cosmos-for-MongoDB throttle resilience.
 *
 * The Cosmos NoSQL SDK we previously used auto-absorbed transient RU throttling
 * (429/503). The official `mongodb` driver does NOT retry Cosmos's RU-exhaustion
 * error (code 16500, "TooManyRequests" / "RequestRateTooLarge"), and with the
 * REQUIRED retrywrites=false it won't retry writes either — so a brief RU spike
 * would otherwise surface as a 500 on login/refresh.
 *
 * Every users-repo operation is idempotent (point read, fixed-value `$set`,
 * replace-by-`_id`), so a bounded retry with backoff is safe and restores the
 * prior resilience. ONLY throttle errors are retried; anything else (including
 * the repo's own "matched no user" error) propagates immediately.
 */

// Cosmos for MongoDB signals RU exhaustion with this server error code.
const THROTTLE_CODE = 16500

/** True for a Cosmos RU-throttle error (and nothing else). */
export function isThrottle(err) {
  return Boolean(err) && (err.code === THROTTLE_CODE || err.codeName === 'TooManyRequests')
}

/** Server-provided backoff hint when present (capped), else exponential + jitter. */
function backoffMs(err, attempt, baseMs) {
  const hint = Number(err?.RetryAfterMs ?? err?.errorResponse?.RetryAfterMs)
  if (Number.isFinite(hint) && hint >= 0) return Math.min(hint, 5_000)
  return baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs) // jitter
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `fn`, retrying ONLY on Cosmos RU-throttle errors with bounded backoff.
 * Non-throttle errors — and the final throttle after `retries` — propagate.
 *
 * @param {() => Promise<any>} fn
 * @param {{retries?: number, baseMs?: number}} [opts]
 */
export async function withThrottleRetry(fn, { retries = 5, baseMs = 50 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isThrottle(err) || attempt >= retries) throw err
      await delay(backoffMs(err, attempt, baseMs))
    }
  }
}
