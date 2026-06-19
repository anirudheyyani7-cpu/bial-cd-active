/**
 * Preseed the BIAL dev / VM environment with the pilot users + one admin.
 *
 *   node scripts/seed-bial-users.js              # create missing users AND reset existing ones' passwords
 *   node scripts/seed-bial-users.js --dry-run    # connect + show the plan, write NOTHING (read-only)
 *
 * Run this ON the target box, or with that box's MONGODB_* in scope — it writes to
 * whatever `MONGODB_URI` / `.env` is loaded (dotenv). On the VM, the VM's `.env`
 * points at the VM's Mongo, so running it there seeds the VM database.
 *
 * Login is by USERNAME, matched as an exact `_id` point-read, so usernames are the
 * emails LOWERCASED (people type lowercase). Each user gets a deterministic,
 * memorable temporary password of the shape `<LastName>BIAL@123` (e.g.
 * `FernandezBIAL@123`), stored only as an Argon2id hash. Every run is a full
 * upsert: missing users are created and existing users have their password reset
 * to the derived value — so the pilot always knows everyone's current password.
 *
 * Reuses the tested seedUsers() upsert from seed-users.js — same hashing, same
 * doc shape, same preserve-createdAt/limits/session semantics.
 */
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { createUsersRepo } from '../server/users-repo.js'
import { getUsersCollection } from '../server/cosmos.js'
import { seedUsers, assertValidUsername, derivePassword } from './seed-users.js'

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

/** The seed map this script ships: every pilot user → its derived password. */
export function bialPasswords(users = BIAL_USERS) {
  return Object.fromEntries(users.map((u) => [u.username, derivePassword(u.name)]))
}

function printResults(results) {
  console.log('\nBIAL pilot users — temporary memorable passwords (<LastName>BIAL@123):\n')
  console.log('  ' + 'STATUS'.padEnd(9) + 'ROLE'.padEnd(7) + 'USERNAME (login)'.padEnd(34) + 'PASSWORD')
  for (const r of results) {
    console.log('  ' + r.status.padEnd(9) + r.role.padEnd(7) + r.username.padEnd(34) + r.password)
  }
  console.log('\nPasswords are deterministic temporary credentials, stored only as Argon2id hashes at rest.')
  console.log('Sign in at /login with the username + password above.\n')
}

export async function dryRun(repo) {
  console.log('\nDRY RUN — no writes. Planned actions against the loaded database:\n')
  console.log('  ' + 'ACTION'.padEnd(16) + 'ROLE'.padEnd(7) + 'USERNAME (login)'.padEnd(34) + 'PASSWORD')
  for (const u of BIAL_USERS) {
    assertValidUsername(u.username)
    const existing = await repo.findByUsername(u.username)
    const action = existing ? 'UPDATE pw' : 'CREATE'
    console.log('  ' + action.padEnd(16) + u.role.padEnd(7) + u.username.padEnd(34) + derivePassword(u.name))
  }
  console.log('')
}

async function main() {
  const dry = process.argv.slice(2).includes('--dry-run')
  try {
    const repo = createUsersRepo(await getUsersCollection())
    if (dry) {
      await dryRun(repo)
      return
    }
    printResults(await seedUsers(repo, { users: BIAL_USERS, passwords: bialPasswords() }))
  } catch (err) {
    console.error('seed-bial-users failed:', err.message)
    process.exitCode = 1
  }
}

// MongoClient keeps a socket open; exit explicitly once done.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().finally(() => process.exit(process.exitCode || 0))
}
