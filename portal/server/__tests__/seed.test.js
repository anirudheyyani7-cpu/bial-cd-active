import { describe, it, expect } from 'vitest'
import { seedUsers, runSeedCli, generatePassword, SEED_USERS } from '../../scripts/seed-users.js'
import { createUsersRepo } from '../users-repo.js'
import { verifyPassword } from '../auth/password.js'
import { makeFakeContainer } from './fakeCosmos.js'

function freshRepo() {
  const container = makeFakeContainer([])
  return { container, repo: createUsersRepo(container) }
}

describe('seed-users', () => {
  it('generatePassword yields a CSPRNG string of at least 16 chars', () => {
    const a = generatePassword()
    const b = generatePassword()
    expect(a.length).toBeGreaterThanOrEqual(16)
    expect(a).not.toBe(b)
  })

  it('seeds the expected users with argon2id (never plaintext) hashes and correct roles', async () => {
    const { container, repo } = freshRepo()
    const results = await seedUsers(repo)

    expect(container._store.size).toBe(SEED_USERS.length)
    expect(results.some((r) => r.role === 'admin')).toBe(true)
    expect(results.some((r) => r.role === 'user')).toBe(true)

    const admin = container._get('admin')
    expect(admin.passwordHash).toMatch(/^\$argon2id\$/)
    expect(admin.passwordHash).not.toContain(results.find((r) => r.username === 'admin').password)
    // the printed password actually verifies against the stored hash
    const adminPw = results.find((r) => r.username === 'admin').password
    await expect(verifyPassword(adminPw, admin.passwordHash)).resolves.toBe(true)
  })

  it('is idempotent — a second run does not duplicate or reset existing users', async () => {
    const { container, repo } = freshRepo()
    await seedUsers(repo)
    const adminHashAfterFirst = container._get('admin').passwordHash

    const second = await seedUsers(repo)
    expect(container._store.size).toBe(SEED_USERS.length)
    expect(second.every((r) => r.status === 'unchanged')).toBe(true)
    expect(container._get('admin').passwordHash).toBe(adminHashAfterFirst) // password not reset
  })

  it('rotates only the targeted user, leaving others intact', async () => {
    const { container, repo } = freshRepo()
    await seedUsers(repo)
    const staffHashBefore = container._get('staff').passwordHash

    const rotated = await seedUsers(repo, { passwords: { admin: 'brand-new-admin-pw' } })
    expect(rotated.find((r) => r.username === 'admin').status).toBe('updated')
    expect(rotated.find((r) => r.username === 'staff').status).toBe('unchanged')
    expect(container._get('staff').passwordHash).toBe(staffHashBefore) // untouched
    await expect(verifyPassword('brand-new-admin-pw', container._get('admin').passwordHash)).resolves.toBe(true)
  })

  it('preserves createdAt and an existing session on rotation', async () => {
    const { container, repo } = freshRepo()
    await seedUsers(repo)
    const created = container._get('admin').createdAt
    // simulate a live session
    await repo.setRefreshHash('admin', 'LIVEHASH', '2099-01-01T00:00:00.000Z')

    await seedUsers(repo, { rotate: true, passwords: { admin: 'rotated-pw' } })
    expect(container._get('admin').createdAt).toBe(created)
    expect(container._get('admin').refreshTokenHash).toBe('LIVEHASH')
  })

  it('runSeedCli propagates a fail-loud collection error (missing env path)', async () => {
    const getCollection = async () => {
      throw new Error('Missing required Mongo env var: MONGODB_DATABASE')
    }
    await expect(runSeedCli({ getCollection })).rejects.toThrow(/Missing required Mongo env var/)
  })
})
