/**
 * Preseed the BIAL dev / VM environment with the pilot users + one admin.
 *
 *   node scripts/seed-bial-users.js              # create any missing users (CSPRNG pw, printed ONCE)
 *   node scripts/seed-bial-users.js --rotate     # ALSO reset passwords for users that already exist
 *   node scripts/seed-bial-users.js --dry-run    # connect + show the plan, write NOTHING (read-only)
 *
 * Run this ON the target box, or with that box's MONGODB_* in scope — it writes to
 * whatever `MONGODB_URI` / `.env` is loaded (dotenv). On the VM, the VM's `.env`
 * points at the VM's Mongo, so running it there seeds the VM database.
 *
 * Login is by USERNAME, matched as an exact `_id` point-read, so usernames are the
 * emails LOWERCASED (people type lowercase). Each user gets a distinct CSPRNG
 * password, printed ONCE for out-of-band distribution and stored only as an
 * Argon2id hash. Re-running is idempotent: existing users are left untouched (their
 * distributed password keeps working) unless you pass --rotate.
 *
 * Reuses the tested seedUsers() upsert from seed-users.js — same hashing, same
 * doc shape, same preserve-createdAt/limits/session semantics.
 */
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { createUsersRepo } from '../server/users-repo.js'
import { getUsersCollection } from '../server/cosmos.js'
import { seedUsers, assertValidUsername } from './seed-users.js'

// One admin + the nine pilot users. Emails normalized to lowercase for login.
// Change the admin line below if you want a different admin identity.
export const BIAL_USERS = [
  { username: 'admin@bialairport.com',          email: 'admin@bialairport.com',          name: 'BIAL Admin',            role: 'admin' },
  { username: 'jacxine@bialairport.com',        email: 'jacxine@bialairport.com',        name: 'Jacxine Fernandez',     role: 'user' },
  { username: 'pankaj.j@bialairport.com',       email: 'pankaj.j@bialairport.com',       name: 'Pankaj Joshi',          role: 'user' },
  { username: 'vijay.agarwal@bialairport.com',  email: 'vijay.agarwal@bialairport.com',  name: 'Vijay Kumar',           role: 'user' },
  { username: 'bichitra@bialairport.com',       email: 'bichitra@bialairport.com',       name: 'Bichitra',              role: 'user' },
  { username: 'shakti@bialairport.com',         email: 'shakti@bialairport.com',         name: 'Shakti Mitra',          role: 'user' },
  { username: 'kranthi.b@bialairport.com',      email: 'kranthi.b@bialairport.com',      name: 'Kranthi Kumar',         role: 'user' },
  { username: 'mohammed.a@bialairport.com',     email: 'mohammed.a@bialairport.com',     name: 'Mohammed Imran Ansari', role: 'user' },
  { username: 'jaison@bialairport.com',         email: 'jaison@bialairport.com',         name: 'Jaison',                role: 'user' },
  { username: 'adiseshu@bialairport.com',       email: 'adiseshu@bialairport.com',       name: 'Adi',                   role: 'user' },
]

function printResults(results) {
  const changed = results.filter((r) => r.password)
  const unchanged = results.filter((r) => !r.password)
  if (changed.length) {
    console.log('\nSeeded BIAL users (shown ONCE — capture and distribute out of band):\n')
    console.log('  ' + 'STATUS'.padEnd(9) + 'ROLE'.padEnd(7) + 'USERNAME (login)'.padEnd(34) + 'PASSWORD')
    for (const r of changed) {
      console.log('  ' + r.status.padEnd(9) + r.role.padEnd(7) + r.username.padEnd(34) + r.password)
    }
  }
  if (unchanged.length) {
    console.log(
      `\nUnchanged (already existed; password NOT reset — pass --rotate to reset):\n  ` +
        unchanged.map((r) => r.username).join(', '),
    )
  }
  console.log('\nPasswords are stored only as Argon2id hashes. Sign in at /login with the username + password above.\n')
}

async function dryRun(repo) {
  console.log('\nDRY RUN — no writes. Planned actions against the loaded database:\n')
  for (const u of BIAL_USERS) {
    assertValidUsername(u.username)
    const existing = await repo.findByUsername(u.username)
    const status = existing ? 'EXISTS (skip unless --rotate)' : 'WOULD CREATE'
    console.log('  ' + status.padEnd(30) + u.role.padEnd(7) + u.username.padEnd(34) + `(${u.name})`)
  }
  console.log('')
}

async function main() {
  const argv = process.argv.slice(2)
  const rotate = argv.includes('--rotate')
  const dry = argv.includes('--dry-run')
  try {
    const repo = createUsersRepo(await getUsersCollection())
    if (dry) {
      await dryRun(repo)
      return
    }
    printResults(await seedUsers(repo, { users: BIAL_USERS, rotate }))
  } catch (err) {
    console.error('seed-bial-users failed:', err.message)
    process.exitCode = 1
  }
}

// MongoClient keeps a socket open; exit explicitly once done.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().finally(() => process.exit(process.exitCode || 0))
}
