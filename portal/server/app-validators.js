/**
 * Validators shared between the per-app repos (data-records + app-files). Only the
 * truly-identical, cross-repo validators live here; repo-specific validators
 * (sanitizeFilename / assertContentType / sniffMagic / sniffImageType, the record
 * sanitizeData / buildSearchBlob / sort+filter helpers) stay in their own module so
 * each trust boundary keeps its own surface.
 */

// The logical `collection` label allowlist — letters/digits/`_-`, 1–64 chars. Shared
// verbatim by data_records and app_files so the two stores agree on what a valid
// collection name is.
export const COLLECTION_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Validate an app-chosen logical `collection` label. Absent → 'default' (the POC
 * single-collection default). PURE; shared with the routes (which map !ok → 400).
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
export function sanitizeCollection(name) {
  if (name === undefined || name === null) return { ok: true, value: 'default' }
  if (typeof name !== 'string' || !COLLECTION_RE.test(name)) {
    return { ok: false, error: 'collection must match ^[A-Za-z0-9_-]{1,64}$' }
  }
  return { ok: true, value: name }
}
