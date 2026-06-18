/**
 * Add (or update) a single portal user — dev/admin utility for the interim auth.
 *
 *   node scripts/add-user.js <email-or-username> [--name "Full Name"] [--role admin|user] [--password <pw>]
 *
 * Login is by USERNAME (the first positional arg). If --password is omitted a
 * CSPRNG password is generated and printed ONCE. The password is stored only as
 * an Argon2id hash; re-running updates the user and resets the password, while
 * preserving createdAt and any live session. Loads .env itself (run from portal/).
 */
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { hashPassword } from '../server/auth/password.js'
import { createUsersRepo } from '../server/users-repo.js'
import { getUsersCollection } from '../server/cosmos.js'
import { generatePassword, assertValidUsername } from './seed-users.js'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--name') args.name = argv[++i]
    else if (a === '--role') args.role = argv[++i]
    else if (a === '--password') args.password = argv[++i]
    else if (a === '--email') args.email = argv[++i]
    else args._.push(a)
  }
  return args
}

/** Upsert one user, returning the (printable-once) password and status. */
export async function addUser(repo, { username, email, name, role = 'user', password } = {}) {
  assertValidUsername(username)
  const existing = await repo.findByUsername(username)
  const pw = password || generatePassword()
  const now = new Date().toISOString()
  await repo.upsertUser({
    _id: username,
    username,
    email: email || username,
    name: name || username,
    role,
    passwordHash: await hashPassword(pw),
    refreshTokenHash: existing?.refreshTokenHash ?? null,
    refreshTokenExpiresAt: existing?.refreshTokenExpiresAt ?? null,
    // Preserve any admin-set per-user limit override across a re-run (this is a
    // full replace, so an omitted field would otherwise be wiped).
    ...(existing?.limits !== undefined && { limits: existing.limits }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  return { username, role, password: pw, status: existing ? 'updated' : 'created' }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const username = args._[0]
  if (!username) {
    console.error('Usage: node scripts/add-user.js <email-or-username> [--name "X"] [--role admin|user] [--password <pw>]')
    process.exitCode = 1
    return
  }
  const role = args.role === 'admin' ? 'admin' : args.role || 'user'
  try {
    const repo = createUsersRepo(await getUsersCollection())
    const r = await addUser(repo, { username, email: args.email, name: args.name, role, password: args.password })
    console.log(
      `\n${r.status} user:\n` +
        `  username: ${r.username}\n` +
        `  role:     ${r.role}\n` +
        `  password: ${r.password}\n\n` +
        'Stored as an Argon2id hash. Sign in at /login with the username + password above.\n',
    )
  } catch (err) {
    console.error('add-user failed:', err.message)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // MongoClient keeps a socket open; exit explicitly once done.
  main().finally(() => process.exit(process.exitCode || 0))
}
