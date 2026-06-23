/**
 * Tiny shared validation helpers. Kept dependency-free so any repo/route can import
 * a single canonical implementation instead of re-declaring its own.
 */

/**
 * Coerce a value to a POSITIVE INTEGER, falling back when it isn't one. Accepts both
 * a numeric string (e.g. an env var like `process.env.APP_FILE_COUNT_CAP`) and an
 * already-numeric value (e.g. a user-document field). A non-integer, ≤0, NaN, or
 * unparseable input yields `fallback`. Single source for the former `_posInt`
 * (app-files.js, app-registry-repo.js) and `posIntOr` (limits.js).
 *
 * @param {unknown} value   - a number or a string to parse
 * @param {number} fallback - returned when `value` is not a positive integer
 * @returns {number}
 */
export function posIntOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}
