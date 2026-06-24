import { describe, it, expect } from 'vitest'
import { seedUsers, derivePassword } from '../../scripts/seed-users.js'
import { BIAL_USERS, bialPasswords, dryRun, seedSafe } from '../../scripts/seed-bial-users.js'
import { createUsersRepo } from '../users-repo.js'
import { verifyPassword } from '../auth/password.js'
import { makeFakeContainer } from './fakeCosmos.js'

function freshRepo(initial = []) {
  const container = makeFakeContainer(initial)
  return { container, repo: createUsersRepo(container) }
}

describe('derivePassword', () => {
  it('uses the last whitespace-delimited token for a multi-word name', () => {
    expect(derivePassword('Jacxine Fernandez')).toBe('FernandezBIAL@123')
  })

  it('falls back to the whole name for a single-word name', () => {
    expect(derivePassword('Bichitra')).toBe('BichitraBIAL@123')
  })

  it('derives from the last token for the admin name', () => {
    expect(derivePassword('BIAL Admin')).toBe('AdminBIAL@123')
  })

  it('is robust to leading/trailing/multiple internal whitespace', () => {
    expect(derivePassword('  Shakti  Mitra ')).toBe('MitraBIAL@123')
  })

  it('strips stray non-alphanumerics from the token', () => {
    expect(derivePassword('Mohammed Imran Ansari')).toBe('AnsariBIAL@123')
    expect(derivePassword("O'Brien")).toBe('OBrienBIAL@123')
  })

  it('falls back to the prior word when the last token strips to empty', () => {
    expect(derivePassword('Foo ---')).toBe('FooBIAL@123')
    expect(derivePassword('Jane  !!!')).toBe('JaneBIAL@123')
  })

  it('capitalizes the first letter regardless of input casing', () => {
    expect(derivePassword('john doe')).toBe('DoeBIAL@123')
    expect(derivePassword('bichitra')).toBe('BichitraBIAL@123')
  })

  it('always contains an uppercase first letter, the literal BIAL, and the @123 suffix', () => {
    for (const u of BIAL_USERS) {
      const pw = derivePassword(u.name)
      expect(pw).toMatch(/^[A-Z]/)
      expect(pw).toContain('BIAL')
      expect(pw.endsWith('@123')).toBe(true)
      // satisfies upper/lower/digit/symbol + length >= 8 by construction
      expect(pw.length).toBeGreaterThanOrEqual(8)
    }
  })
})

describe('seed-bial (create + update)', () => {
  it('creates every BIAL user with an argon2id hash that verifies its derived password', async () => {
    const { container, repo } = freshRepo()
    const passwords = bialPasswords()

    const results = await seedUsers(repo, { users: BIAL_USERS, passwords })

    expect(container._store.size).toBe(BIAL_USERS.length)
    expect(results.every((r) => r.status === 'created')).toBe(true)

    for (const u of BIAL_USERS) {
      const stored = container._get(u.username)
      const expected = derivePassword(u.name)
      // the result row carries the derived password verbatim — this is exactly
      // what printResults shows the operator, so pin it.
      expect(results.find((r) => r.username === u.username).password).toBe(expected)
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/)
      expect(stored.passwordHash).not.toContain(expected) // never plaintext
      expect(stored.password).toBeUndefined() // no plaintext field at rest
      await expect(verifyPassword(expected, stored.passwordHash)).resolves.toBe(true)
    }
  })

  it('updates an already-existing user to the new derived password in the same pass', async () => {
    const target = BIAL_USERS[1] // Jacxine Fernandez
    const { container, repo } = freshRepo()

    // Pre-seed this user with an old, non-derived password.
    await seedUsers(repo, { users: [target], passwords: { [target.username]: 'old-temp-password' } })
    const oldHash = container._get(target.username).passwordHash

    const results = await seedUsers(repo, { users: BIAL_USERS, passwords: bialPasswords() })

    const row = results.find((r) => r.username === target.username)
    expect(row.status).toBe('updated')
    expect(row.password).toBe(derivePassword(target.name)) // printed value is the derived one

    const stored = container._get(target.username)
    const derived = derivePassword(target.name)
    expect(stored.passwordHash).not.toBe(oldHash)
    await expect(verifyPassword(derived, stored.passwordHash)).resolves.toBe(true)
    await expect(verifyPassword('old-temp-password', stored.passwordHash)).resolves.toBe(false)
  })

  it('preserves createdAt, an existing session, and admin limit overrides on update', async () => {
    const target = BIAL_USERS[2] // Pankaj Joshi
    const { container, repo } = freshRepo()

    await seedUsers(repo, { users: [target], passwords: { [target.username]: 'old-temp-password' } })
    const createdAt = container._get(target.username).createdAt
    await repo.setRefreshHash(target.username, 'LIVEHASH', '2099-01-01T00:00:00.000Z')
    await repo.updateLimits(target.username, { dailyTokenLimit: 12345 })

    await seedUsers(repo, { users: BIAL_USERS, passwords: bialPasswords() })

    const stored = container._get(target.username)
    expect(stored.createdAt).toBe(createdAt)
    expect(stored.refreshTokenHash).toBe('LIVEHASH')
    expect(stored.limits.dailyTokenLimit).toBe(12345)
  })
})

describe('seed-bial safe default (seedSafe)', () => {
  it('creates only the missing users and never resets an existing password', async () => {
    const existing = BIAL_USERS[1] // Jacxine Fernandez — pre-seeded with a non-derived password
    const { container, repo } = freshRepo()
    await seedUsers(repo, { users: [existing], passwords: { [existing.username]: 'old-temp-password' } })
    const oldHash = container._get(existing.username).passwordHash

    const results = await seedSafe(repo)

    // every roster user now exists exactly once
    expect(container._store.size).toBe(BIAL_USERS.length)
    // pre-existing user untouched: same hash, still verifies the original password
    expect(container._get(existing.username).passwordHash).toBe(oldHash)
    await expect(verifyPassword('old-temp-password', oldHash)).resolves.toBe(true)
    expect(results.find((r) => r.username === existing.username).status).toBe('unchanged')

    // the brand-new user (Imran Khan) was created with its derived password
    const imran = BIAL_USERS.find((u) => u.username === 'imran.khan@bialairport.com')
    const imranRow = results.find((r) => r.username === imran.username)
    expect(imranRow.status).toBe('created')
    expect(imranRow.password).toBe(derivePassword(imran.name)) // KhanBIAL@123
    await expect(
      verifyPassword(derivePassword(imran.name), container._get(imran.username).passwordHash),
    ).resolves.toBe(true)
  })

  it('reconciles a drifted display name WITHOUT changing the password', async () => {
    const u = BIAL_USERS.find((x) => x.username === 'kranthi.b@bialairport.com')
    const { container, repo } = freshRepo()
    // Simulate the already-created account: OLD name + a known distributed password.
    await seedUsers(repo, {
      users: [{ ...u, name: 'Kranthi Kumar' }],
      passwords: { [u.username]: 'KumarBIAL@123' },
    })
    const oldHash = container._get(u.username).passwordHash

    const results = await seedSafe(repo)

    const stored = container._get(u.username)
    expect(stored.name).toBe('Kranthi Kumar Bugga') // roster name applied
    expect(stored.passwordHash).toBe(oldHash) // password hash untouched
    await expect(verifyPassword('KumarBIAL@123', stored.passwordHash)).resolves.toBe(true)
    const row = results.find((r) => r.username === u.username)
    expect(row.status).toBe('name-updated')
    expect(row.password).toBeNull()
  })

  it('is idempotent — a second run reports everyone unchanged and rewrites no password', async () => {
    const { container, repo } = freshRepo()
    await seedSafe(repo) // first run creates all roster users
    const sizeAfterFirst = container._store.size
    const hashes = new Map([...container._store.keys()].map((k) => [k, container._get(k).passwordHash]))

    const results = await seedSafe(repo)

    expect(container._store.size).toBe(sizeAfterFirst)
    expect(results.every((r) => r.status === 'unchanged')).toBe(true)
    for (const [k, h] of hashes) expect(container._get(k).passwordHash).toBe(h)
  })

  it('--rotate path (explicit passwords) DOES reset an existing password', async () => {
    const u = BIAL_USERS[3] // Vijay Kumar
    const { container, repo } = freshRepo()
    await seedUsers(repo, { users: [u], passwords: { [u.username]: 'old-temp-password' } })

    // This is exactly what main() runs for `--rotate`.
    await seedUsers(repo, { users: BIAL_USERS, passwords: bialPasswords(), rotate: true })

    const stored = container._get(u.username)
    await expect(verifyPassword(derivePassword(u.name), stored.passwordHash)).resolves.toBe(true)
    await expect(verifyPassword('old-temp-password', stored.passwordHash)).resolves.toBe(false)
  })
})

describe('seed-bial dry run', () => {
  it('performs no writes against the loaded database', async () => {
    const { container, repo } = freshRepo()
    await dryRun(repo)
    expect(container._store.size).toBe(0)
  })

  it('leaves a pre-existing user untouched', async () => {
    const target = BIAL_USERS[0]
    const { container, repo } = freshRepo()
    await seedUsers(repo, { users: [target], passwords: { [target.username]: 'old-temp-password' } })
    const before = container._get(target.username).passwordHash

    await dryRun(repo)

    expect(container._store.size).toBe(1)
    expect(container._get(target.username).passwordHash).toBe(before)
  })
})
