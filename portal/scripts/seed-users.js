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
 * Upsert the seed users into `repo`.
 * @param {{passwords?: Record<string,string>, rotate?: boolean, users?: object[]}} opts
 * @returns {Promise<Array<{username,role,password,status}>>}
 *   `password` is non-null only for created/updated rows (for one-time print).
 */
export async function seedUsers(repo, { users = SEED_USERS, passwords = {}, rotate = false } = {}) {
  const results = []
  for (const u of users) {
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
