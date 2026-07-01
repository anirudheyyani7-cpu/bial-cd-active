/**
 * Preseed the BIAL dev / VM environment with the pilot users + one admin.
 *
 *   node scripts/seed-bial-users.js              # SAFE: create missing users only; never reset existing passwords
 *   node scripts/seed-bial-users.js --rotate     # force-reset EVERY pilot's password to the derived value
 *   node scripts/seed-bial-users.js --dry-run    # connect + show the plan, write NOTHING (read-only)
 *
 * Run this ON the target box, or with that box's MONGODB_* in scope — it writes to
 * whatever `MONGODB_URI` / `.env` is loaded (dotenv). On the VM, the VM's `.env`
 * points at the VM's Mongo, so running it there seeds the VM database.
 *
 * Login is by USERNAME, matched as an exact `_id` point-read, so usernames are the
 * emails LOWERCASED (people type lowercase). Each NEW user gets a deterministic,
 * memorable temporary password of the shape `<LastName>BIAL@123` (e.g.
 * `FernandezBIAL@123`), stored only as an Argon2id hash.
 *
 * Safe by default (so re-running after onboarding more users never clobbers
 * already-distributed credentials):
 *   - missing users        → CREATED with their derived password
 *   - existing, name drift  → display-name reconciled (password PRESERVED)
 *   - existing, no drift    → UNCHANGED
 * Pass `--rotate` to deliberately reset every pilot back to the derived password
 * (the old full-upsert behaviour) when you need everyone's password re-issued.
 *
 * Reuses the tested seedUsers() upsert from seed-users.js for the create/rotate
 * paths — same hashing, same doc shape, same preserve-createdAt/limits/session
 * semantics — and users-repo.updateName() for the password-safe name reconcile.
 */
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { createUsersRepo } from '../server/users-repo.js'
import { getUsersCollection } from '../server/cosmos.js'
import { seedUsers, assertValidUsername, derivePassword } from './seed-users.js'

// One admin + the BIAL pilot users. Emails normalized to lowercase for login.
// Change the admin line below if you want a different admin identity.
export const BIAL_USERS = [
  { username: 'admin@bialairport.com',          email: 'admin@bialairport.com',          name: 'BIAL Admin',            role: 'admin' },
  { username: 'jacxine@bialairport.com',        email: 'jacxine@bialairport.com',        name: 'Jacxine Fernandez',     role: 'user' },
  { username: 'pankaj.j@bialairport.com',       email: 'pankaj.j@bialairport.com',       name: 'Pankaj Joshi',          role: 'user' },
  { username: 'vijay.agarwal@bialairport.com',  email: 'vijay.agarwal@bialairport.com',  name: 'Vijay Kumar',           role: 'user' },
  { username: 'bichitra@bialairport.com',       email: 'bichitra@bialairport.com',       name: 'Bichitra',              role: 'user' },
  { username: 'shakti@bialairport.com',         email: 'shakti@bialairport.com',         name: 'Shakti Mitra',          role: 'user' },
  { username: 'kranthi.b@bialairport.com',      email: 'kranthi.b@bialairport.com',      name: 'Kranthi Kumar Bugga',   role: 'user' },
  { username: 'mohammed.a@bialairport.com',     email: 'mohammed.a@bialairport.com',     name: 'Mohammed Imran Ansari', role: 'user' },
  { username: 'jaison@bialairport.com',         email: 'jaison@bialairport.com',         name: 'Jaison',                role: 'user' },
  { username: 'adiseshu@bialairport.com',       email: 'adiseshu@bialairport.com',       name: 'Adi',                   role: 'user' },
  { username: 'imran.khan@bialairport.com',     email: 'imran.khan@bialairport.com',     name: 'Imran Khan',            role: 'user' },
  { username: 'jonathan.b@bialairport.com',     email: 'jonathan.b@bialairport.com',     name: 'Jonathan Varun Benjamin', role: 'user' },
  { username: 'sidhant.g@bialairport.com',      email: 'sidhant.g@bialairport.com',      name: 'Sidhant Goel',           role: 'user' },
  { username: 'pravind.kumar@bialairport.com',  email: 'pravind.kumar@bialairport.com',  name: 'Pravind Kumar',          role: 'user' },
  { username: 'ravichandran.p@bialairport.com', email: 'ravichandran.p@bialairport.com', name: 'Ravichandran P',         role: 'user' },
  { username: 'venkateswaran@bialairport.com',  email: 'venkateswaran@bialairport.com',  name: 'Dr. Venkat',             role: 'user' },
  { username: 'vikas.pruthi@bialairport.com',   email: 'vikas.pruthi@bialairport.com',   name: 'Vikas Pruthi',           role: 'user' },
  { username: 'prithvi@bialairport.com',        email: 'prithvi@bialairport.com',        name: 'Prithvi Ponnappa',       role: 'user' },
  { username: 'schaudhari@bialairport.com',     email: 'schaudhari@bialairport.com',     name: 'Sandeep Chaudhari',      role: 'user' },
  { username: 'priyaranjan.p@bialairport.com',      email: 'priyaranjan.p@bialairport.com',      name: 'Priyaranjan Pati',       role: 'user' },
  { username: 'rahul.kohli@bialairport.com',           email: 'rahul.kohli@bialairport.com',           name: 'Rahul Kohli',            role: 'user' },
]

/** The seed map this script ships: every pilot user → its derived password. */
export function bialPasswords(users = BIAL_USERS) {
  return Object.fromEntries(users.map((u) => [u.username, derivePassword(u.name)]))
}

/**
 * Safe seed: CREATE only the users that don't exist yet (with their derived
 * password), reconcile a drifted display name without touching the password, and
 * leave everyone else untouched. Reuses the tested seedUsers() for the create
 * path so existing users — those with no explicit password and rotate off — are
 * left alone, and uses updateName() for the password-safe rename. Returns the
 * same `{username, role, password, status}` rows printResults expects (plus a
 * `detail` string on renames), in roster order.
 */
export async function seedSafe(repo) {
  const newUsers = []
  const plan = []
  for (const u of BIAL_USERS) {
    assertValidUsername(u.username)
    const existing = await repo.findByUsername(u.username)
    plan.push({ u, existing })
    if (!existing) newUsers.push(u)
  }

  const created = newUsers.length
    ? await seedUsers(repo, { users: newUsers, passwords: bialPasswords(newUsers) })
    : []
  const createdByUser = new Map(created.map((r) => [r.username, r]))

  const results = []
  for (const { u, existing } of plan) {
    if (!existing) {
      results.push(createdByUser.get(u.username)) // status 'created', derived password
    } else if (existing.name !== u.name) {
      await repo.updateName(u.username, u.name) // password PRESERVED
      results.push({
        username: u.username,
        role: u.role,
        password: null,
        status: 'name-updated',
        detail: `${existing.name} → ${u.name}`,
      })
    } else {
      results.push({ username: u.username, role: u.role, password: null, status: 'unchanged' })
    }
  }
  return results
}

function printResults(results) {
  console.log('\nBIAL pilot users — temporary memorable passwords (<LastName>BIAL@123):\n')
  console.log('  ' + 'STATUS'.padEnd(13) + 'ROLE'.padEnd(7) + 'USERNAME (login)'.padEnd(34) + 'PASSWORD')
  for (const r of results) {
    // null password = existing user we left alone (unchanged / renamed).
    console.log('  ' + r.status.padEnd(13) + r.role.padEnd(7) + r.username.padEnd(34) + (r.password ?? '(unchanged)'))
  }
  const renamed = results.filter((r) => r.status === 'name-updated' && r.detail)
  if (renamed.length) {
    console.log('\nDisplay-name updates (password preserved):')
    for (const r of renamed) console.log(`  ${r.username}: ${r.detail}`)
  }
  console.log('\nPasswords are deterministic temporary credentials, stored only as Argon2id hashes at rest.')
  console.log('Existing users are never re-passworded by default — pass --rotate to reset everyone.')
  console.log('Sign in at /login with the username + password above.\n')
}

export async function dryRun(repo, { rotate = false } = {}) {
  console.log('\nDRY RUN — no writes. Planned actions against the loaded database:\n')
  console.log('  ' + 'ACTION'.padEnd(13) + 'ROLE'.padEnd(7) + 'USERNAME (login)'.padEnd(34) + 'PASSWORD / NOTE')
  for (const u of BIAL_USERS) {
    assertValidUsername(u.username)
    const existing = await repo.findByUsername(u.username)
    let action
    let note
    if (rotate) {
      action = existing ? 'RESET pw' : 'CREATE'
      note = derivePassword(u.name)
    } else if (!existing) {
      action = 'CREATE'
      note = derivePassword(u.name)
    } else if (existing.name !== u.name) {
      action = 'NAME-UPDATE'
      note = `${existing.name} → ${u.name} (pw kept)`
    } else {
      action = 'UNCHANGED'
      note = '(pw kept)'
    }
    console.log('  ' + action.padEnd(13) + u.role.padEnd(7) + u.username.padEnd(34) + note)
  }
  console.log('')
}

async function main() {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry-run')
  const rotate = argv.includes('--rotate')
  try {
    const repo = createUsersRepo(await getUsersCollection())
    if (dry) {
      await dryRun(repo, { rotate })
      return
    }
    const results = rotate
      ? await seedUsers(repo, { users: BIAL_USERS, passwords: bialPasswords(), rotate: true })
      : await seedSafe(repo)
    printResults(results)
  } catch (err) {
    console.error('seed-bial-users failed:', err.message)
    process.exitCode = 1
  }
}

// MongoClient keeps a socket open; exit explicitly once done.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().finally(() => process.exit(process.exitCode || 0))
}
