/**
 * Daily per-user token-usage data-access seam.
 *
 * `createUsageRepo(collection)` wraps a Mongo collection (real or fake) so the
 * `/api/claude` enforcement gate is testable without a live Cosmos and the later
 * FastAPI port (`token_usage` table) is mechanical. Documents are keyed by
 * `_id` = `${username}:${IST-date}` — one single-document point read per request.
 *
 * The IST date/reset helpers live here (co-located, not a separate module)
 * because usage is the only consumer of "what calendar day is it in India and
 * when does the counter reset". IST has no DST, so the fixed +05:30 offset is
 * always valid.
 *
 * Each driver call is wrapped in withThrottleRetry so a transient Cosmos RU
 * throttle (16500) is retried rather than surfacing as a 500 — see addUsage for
 * the precise idempotency reasoning that keeps a retry from double-counting.
 */
import { withThrottleRetry } from './mongo-retry.js'

// en-CA formats as ISO-style YYYY-MM-DD; pinning the time zone yields the IST
// calendar date regardless of the server's local zone. Built once (the
// Intl formatter is reusable and the construction is non-trivial).
const IST_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })

/** The IST calendar date for `now`, as `YYYY-MM-DD`. Daily counter reset key. */
export function istDateKey(now = new Date()) {
  return IST_DATE_FMT.format(now)
}

/**
 * The next IST-midnight after `now`, as a UTC ISO string (for the reset badge).
 * Advance the IST date key by one calendar day using UTC math (no local-TZ
 * drift), then anchor it at IST midnight via the fixed +05:30 offset. Do NOT use
 * `new Date(`${key}T00:00:00`)` — that parses in the server's local zone.
 */
export function nextIstMidnightIso(now = new Date()) {
  const [y, m, d] = istDateKey(now).split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1)) // Date.UTC normalizes month/day overflow
  const nextKey = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate(),
  ).padStart(2, '0')}`
  return new Date(`${nextKey}T00:00:00+05:30`).toISOString()
}

/**
 * @param {object} collection - a Mongo collection handle (or a compatible fake)
 */
export function createUsageRepo(collection) {
  /** Point-read today's usage doc for a user. null on miss (never seen today). */
  async function getUsage(username, dateKey) {
    return await withThrottleRetry(() => collection.findOne({ _id: `${username}:${dateKey}` }))
  }

  /** Accumulate billed input/output tokens for a user's IST day (upsert). */
  async function addUsage(username, dateKey, input, output) {
    const _id = `${username}:${dateKey}`
    const now = new Date().toISOString()
    // Idempotency under throttle: withThrottleRetry ONLY retries Cosmos 16500
    // (TooManyRequests), which is a PRE-execution rejection — the $inc never
    // applied, so a retry cannot double-count. Non-throttle errors (including a
    // lost-ack network error, since retrywrites=false) are NOT retried; they
    // propagate to the caller's post-stream try/catch and are swallowed there,
    // so at worst one increment is dropped (under-count) — never a double-count.
    await withThrottleRetry(() =>
      collection.updateOne(
        { _id },
        {
          $inc: { inputTokens: input, outputTokens: output },
          $setOnInsert: { username, date: dateKey, createdAt: now },
          $set: { updatedAt: now },
        },
        { upsert: true },
      ),
    )
  }

  return { getUsage, addUsage }
}
