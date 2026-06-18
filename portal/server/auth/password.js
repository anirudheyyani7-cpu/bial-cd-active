/**
 * Password hashing — Argon2id, single path, fail-loud.
 *
 * `@node-rs/argon2` ships prebuilt NAPI binaries (no node-gyp), so if the
 * native module is unavailable the `import` below throws at startup rather
 * than silently degrading. There is deliberately NO bcrypt fallback. The full
 * PHC string is stored so params travel with the hash and stay verifiable by
 * Python `pwdlib`/`argon2-cffi` in the later FastAPI rewrite.
 */
import { hash, verify, Algorithm } from '@node-rs/argon2'

// OWASP 2026 Argon2id baseline.
const HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
}

/** Hash a plaintext password into an `$argon2id$...` PHC string. */
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: password must be a non-empty string')
  }
  return hash(plain, HASH_OPTIONS)
}

/**
 * Verify a plaintext password against a stored PHC string. Returns false
 * (never throws) for a wrong password or a malformed/foreign hash, so callers
 * fail closed.
 */
export async function verifyPassword(plain, phc) {
  if (typeof phc !== 'string' || !phc.startsWith('$argon2')) return false
  try {
    return await verify(phc, plain)
  } catch {
    return false
  }
}
