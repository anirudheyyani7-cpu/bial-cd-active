/**
 * Idempotent user preseed for the interim auth (≥1 admin, ≥1 regular user).
 *
 * Passwords are CSPRNG-generated (never username-derived), printed ONCE for
 * out-of-band distribution, and stored only as Argon2id hashes. Re-running is
 * a no-op for users that already exist (their distributed password is NOT
 * reset). Pass `rotate`/explicit passwords to deliberately change a hash.
 *
 *   npm run seed
 */
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { hashPassword } from '../server/auth/password.js'
import { createUsersRepo } from '../server/users-repo.js'
import { getUsersCollection } from '../server/cosmos.js'

export const SEED_USERS = [
  { username: 'admin', email: 'admin@bial.example', name: 'BIAL Admin', role: 'admin' },
  { username: 'staff', email: 'staff@bial.example', name: 'BIAL Staff', role: 'user' },
]

/** CSPRNG password (≥16 chars, base64url, not username-derived). */
export function generatePassword(bytes = 18) {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Memorable temporary password for the BIAL pilot: `<LastName>BIAL@123`, where
 * `<LastName>` is the last whitespace-delimited token of `name` with its first
 * letter capitalized (single-token names use the whole name). Each token is
 * stripped to ASCII alphanumerics — accented letters are dropped so the result
 * stays easy to type — and tokens that strip to empty are skipped, so a trailing
 * punctuation token (e.g. "Foo -") falls back to the prior word. Capitalizing
 * guarantees the leading-uppercase the login policy expects regardless of input
 * casing; for any name with an alphanumeric token the result satisfies
 * upper/lower/digit/symbol + length ≥ 8 by construction. Not unique — two users
 * sharing a last name collide harmlessly. Used by the BIAL pilot seed only; the
 * generic seed path keeps the CSPRNG `generatePassword` above.
 */
export function derivePassword(name) {
  const tokens = String(name)
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
  const lastToken = tokens[tokens.length - 1] ?? ''
  const capitalized = lastToken.charAt(0).toUpperCase() + lastToken.slice(1)
  return `${capitalized}BIAL@123`
}

/**
 * Reject usernames that would break the `${username}:${IST-date}` usage doc _id
 * keying (plan Decision 3). Usernames are emails today, but guard the creation
 * path so a `:`/whitespace username can never collide usage rows.
 */
export function assertValidUsername(username) {
  if (typeof username !== 'string' || username.trim() === '') {
    throw new Error('Username is required.')
  }
  if (/[:\s]/.test(username)) {
    throw new Error(`Invalid username "${username}": it must not contain ':' or whitespace.`)
  }
}

/**
 * Upsert the seed users into `repo`.
 * @param {{passwords?: Record<string,string>, rotate?: boolean, users?: object[]}} opts
 * @returns {Promise<Array<{username,role,password,status}>>}
 *   `password` is non-null only for created/updated rows (for one-time print).
 */
export async function seedUsers(repo, { users = SEED_USERS, passwords = {}, rotate = false } = {}) {
  const results = []
  for (const u of users) {
    assertValidUsername(u.username)
    const existing = await repo.findByUsername(u.username)
    const explicit = passwords[u.username]

    // Existing user, no explicit password, not rotating → leave untouched so
    // already-distributed credentials keep working across redeploys.
    if (existing && !explicit && !rotate) {
      results.push({ username: u.username, role: u.role, password: null, status: 'unchanged' })
      continue
    }

    const password = explicit || generatePassword()
    const now = new Date().toISOString()
    await repo.upsertUser({
      _id: u.username,
      username: u.username,
      email: u.email,
      name: u.name,
      role: u.role,
      passwordHash: await hashPassword(password),
      // preserve any live session on rotation; default to no session
      refreshTokenHash: existing?.refreshTokenHash ?? null,
      refreshTokenExpiresAt: existing?.refreshTokenExpiresAt ?? null,
      // preserve any admin-set per-user limit override (full replace would wipe it)
      ...(existing?.limits !== undefined && { limits: existing.limits }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    results.push({ username: u.username, role: u.role, password, status: existing ? 'updated' : 'created' })
  }
  return results
}

/** CLI seam — collection-getter is injectable so tests never hit live Cosmos. */
export async function runSeedCli({ getCollection = getUsersCollection, passwords, rotate } = {}) {
  const collection = await getCollection()
  const repo = createUsersRepo(collection)
  return seedUsers(repo, { passwords, rotate })
}

function printResults(results) {
  const changed = results.filter((r) => r.password)
  if (changed.length === 0) {
    console.log('\nAll seed users already present — nothing to do.\n')
    return
  }
  console.log('\nSeeded users (store securely — shown once, distribute out of band):\n')
  for (const r of changed) {
    console.log(`  ${r.status.padEnd(8)} ${r.role.padEnd(6)} ${r.username}  ${r.password}`)
  }
  console.log('\nPasswords are stored only as Argon2id hashes.\n')
}

async function main() {
  try {
    printResults(await runSeedCli())
  } catch (err) {
    console.error('Seed failed:', err.message)
    process.exitCode = 1
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
